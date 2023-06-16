import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as pipeline from "aws-cdk-lib/aws-codepipeline";
import * as pipelineactions from "aws-cdk-lib/aws-codepipeline-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as custom from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { CodeDeployEcsDeployActionRegion } from "./deploy-multi-region";

export class CodepipelineBuildDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Creates an Elastic Container Registry (ECR) image repository
    const imageRepo = new ecr.Repository(this, "imageRepo", {});
    new ecr.CfnReplicationConfiguration(this, "imageRepoReplication", {
      replicationConfiguration: {
        rules: [
          {
            destinations: [
              {
                region: "us-east-1",
                registryId: this.account,
              },
            ],
          },
        ],
      },
    });

    // Creates new pipeline artifacts
    const sourceArtifact = new pipeline.Artifact("SourceArtifact");

    // Creates a Task Definition for the ECS Fargate service
    const fargateTaskDef = new ecs.FargateTaskDefinition(
      this,
      "FargateTaskDef",
      {
        family: "codedeploy-sample",
      }
    );
    fargateTaskDef.addContainer("container", {
      containerName: "web",
      image: ecs.ContainerImage.fromEcrRepository(imageRepo),
      portMappings: [{ containerPort: 80 }],
      environment: {
        NODE_ENV: "production",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/queue",
      },
    });

    // CodeBuild project that builds the Docker image
    const buildImage = new codebuild.Project(this, "BuildImage", {
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        "typescript/codepipeline-build-deploy/app/buildspec.yaml"
      ),
      source: codebuild.Source.gitHub({
        owner: "Vatoth",
        repo: "aws-cdk-examples",
      }),
      environment: {
        privileged: true,
        environmentVariables: {
          AWS_ACCOUNT_ID: { value: process.env?.CDK_DEFAULT_ACCOUNT || "" },
          REGION: { value: process.env?.CDK_DEFAULT_REGION || "" },
          IMAGE_REPO_NAME: { value: imageRepo.repositoryName },
          REPOSITORY_URI: { value: imageRepo.repositoryUri },
          TASK_DEFINITION_ARN: { value: fargateTaskDef.taskDefinitionArn },
          TASK_DEFINITION_NAME: { value: fargateTaskDef.family },
          TASK_ROLE_ARN: { value: fargateTaskDef.taskRole.roleArn },
          EXECUTION_ROLE_ARN: { value: fargateTaskDef.executionRole?.roleArn },
        },
      },
      role: new iam.Role(this, "CodeBuildRole", {
        assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
        inlinePolicies: {
          ECRPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["ecs:DescribeTaskDefinition"],
                resources: ["*"],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "ecr:BatchCheckLayerAvailability",
                  "ecr:CompleteLayerUpload",
                  "ecr:GetAuthorizationToken",
                  "ecr:InitiateLayerUpload",
                  "ecr:PutImage",
                  "ecr:UploadLayerPart",
                ],
                resources: [
                  imageRepo.repositoryArn,
                  `${imageRepo.repositoryArn}:*`,
                ],
              }),
            ],
          }),
        },
      }),
    });

    // Grants CodeBuild project access to pull/push images from/to ECR repo
    imageRepo.grantPullPush(buildImage);

    // Triggers a buid AWS SDK
    const buildTrigger = new custom.AwsCustomResource(
      this,
      "CodeBuildStartBuild",
      {
        installLatestAwsSdk: true,
        policy: custom.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["codebuild:StartBuild"],
            resources: ["*"],
          }),
        ]),
        onUpdate: {
          service: "CodeBuild",
          action: "startBuild",

          physicalResourceId: {
            id: Date.now().toString(),
          },
          parameters: {
            projectName: buildImage.projectName,
          },
        },
      }
    );

    // Creates VPC for the ECS Cluster
    const clusterVpc = new ec2.Vpc(this, "ClusterVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.50.0.0/16"),
    });

    // Deploys the cluster VPC after the initial image build triggers
    clusterVpc.node.addDependency(buildTrigger);

    // CodeBuild project that builds the Docker image
    const runDbMigrationProject = new codebuild.Project(
      this,
      "RunDbMigration",
      {
        buildSpec: codebuild.BuildSpec.fromSourceFilename(
          "typescript/codepipeline-build-deploy/app/buildspec-migrations.yaml"
        ),
        source: codebuild.Source.gitHub({
          owner: "Vatoth",
          repo: "aws-cdk-examples",
        }),
        environment: {
          privileged: true,
          environmentVariables: {},
        },
        vpc: clusterVpc,
      }
    );

    // Triggers a buid AWS SDK
    new custom.AwsCustomResource(this, "CodeBuildStartBuildRunMigration", {
      installLatestAwsSdk: true,
      policy: custom.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["codebuild:StartBuild"],
          resources: ["*"],
        }),
      ]),
      onUpdate: {
        service: "CodeBuild",
        action: "startBuild",

        physicalResourceId: {
          id: Date.now().toString(),
        },
        parameters: {
          projectName: runDbMigrationProject.projectName,
        },
      },
    });

    // Creates a new blue Target Group that routes traffic from the public Application Load Balancer (ALB) to the
    // registered targets within the Target Group e.g. (EC2 instances, IP addresses, Lambda functions)
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html
    const targetGroupBlue = new elb.ApplicationTargetGroup(
      this,
      "BlueTargetGroup",
      {
        targetGroupName: "alb-blue-tg",
        targetType: elb.TargetType.IP,
        port: 80,
        vpc: clusterVpc,
      }
    );

    // Creates a new green Target Group
    const targetGroupGreen = new elb.ApplicationTargetGroup(
      this,
      "GreenTargetGroup",
      {
        targetGroupName: "alb-green-tg",
        targetType: elb.TargetType.IP,
        port: 80,
        vpc: clusterVpc,
      }
    );

    // Creates a Security Group for the Application Load Balancer (ALB)
    const albSg = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: clusterVpc,
      allowAllOutbound: true,
    });
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allows access on port 80/http",
      false
    );

    // Creates a public ALB
    const publicAlb = new elb.ApplicationLoadBalancer(this, "PublicAlb", {
      vpc: clusterVpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // Adds a listener on port 80 to the ALB
    const albListener = publicAlb.addListener("AlbListener80", {
      open: false,
      port: 80,
      defaultTargetGroups: [targetGroupBlue],
    });

    // Creates an ECS Fargate service
    const fargateService = new ecs.FargateService(this, "FargateService", {
      desiredCount: 1,
      serviceName: "fargate-frontend-service",
      taskDefinition: fargateTaskDef,
      cluster: new ecs.Cluster(this, "EcsCluster", {
        enableFargateCapacityProviders: true,
        vpc: clusterVpc,
      }),
      // Sets CodeDeploy as the deployment controller
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY,
      },
    });

    // Adds the ECS Fargate service to the ALB target group
    fargateService.attachToApplicationTargetGroup(targetGroupBlue);

    const buildArtifact = new pipeline.Artifact("BuildArtifact");

    // Creates the source stage for CodePipeline
    const sourceStage = {
      stageName: "Source",
      actions: [
        new pipelineactions.CodeStarConnectionsSourceAction({
          actionName: "GitHub_Source",
          owner: "Vatoth",
          repo: "aws-cdk-examples",
          connectionArn:
            "arn:aws:codestar-connections:eu-west-1:716658718325:connection/c6e61806-e906-411e-865b-8af922a5568f",
          output: sourceArtifact,
          branch: "master",
        }),
      ],
    };

    // Creates the build stage for CodePipeline
    const buildStage = {
      stageName: "Build",
      actions: [
        new pipelineactions.CodeBuildAction({
          actionName: "DockerBuildPush",
          input: sourceArtifact,
          project: buildImage,
          outputs: [buildArtifact],
        }),
      ],
    };

    const runMigrationStage = {
      stageName: "RunDbMigration",
      actions: [
        new pipelineactions.CodeBuildAction({
          actionName: "RunDbMigration",
          input: sourceArtifact,
          project: runDbMigrationProject,
        }),
      ],
    };

    // Creates a new CodeDeploy Deployment Group
    const deploymentGroup = new codedeploy.EcsDeploymentGroup(
      this,
      "CodeDeployGroup",
      {
        service: fargateService,
        // Configurations for CodeDeploy Blue/Green deployments
        blueGreenDeploymentConfig: {
          listener: albListener,
          blueTargetGroup: targetGroupBlue,
          greenTargetGroup: targetGroupGreen,
        },
      }
    );

    // Creates the deploy stage for CodePipeline
    const deployStage: pipeline.StageProps = {
      stageName: "Deploy",
      actions: [
        new pipelineactions.CodeDeployEcsDeployAction({
          actionName: "EcsFargateDeploy",
          appSpecTemplateInput: buildArtifact,
          taskDefinitionTemplateInput: buildArtifact,
          deploymentGroup: deploymentGroup,
        }),
      ],
    };

    // Creates an AWS CodePipeline with source, build, and deploy stages
    const pipelineDeploy = new pipeline.Pipeline(this, "BuildDeployPipeline", {
      pipelineName: "ImageBuildDeployPipeline",
      crossAccountKeys: true,
      crossRegionReplicationBuckets: {
        "us-east-1": s3.Bucket.fromBucketName(
          this,
          "UsEast1ReplicationBucket",
          "my-us-east-1-replication-bucket"
        ),
        "us-west-1": s3.Bucket.fromBucketName(
          this,
          "UsWest1ReplicationBucket",
          "my-us-west-1-replication-bucket"
        ),
        "eu-west-1": new s3.Bucket(this, "eu-west-1"),
      },
      reuseCrossRegionSupportStacks: true,
    });

    pipelineDeploy.artifactBucket;
    pipelineDeploy.addStage(sourceStage);
    pipelineDeploy.addStage(buildStage);
    pipelineDeploy.addStage(runMigrationStage);
    pipelineDeploy.addStage(deployStage);

    const regions = ["us-east-1", "us-west-1", "eu-west-1"];
    const deployMultiRegionStage = pipelineDeploy.addStage({
      stageName: "DeployMutilregion",
    });
    for (const iterator of regions) {
      deployMultiRegionStage.addAction(
        new CodeDeployEcsDeployActionRegion({
          actionName: `EcsFargateDeploy-${iterator}`,
          appSpecTemplateInput: buildArtifact,
          taskDefinitionTemplateInput: buildArtifact,
          deploymentGroup: deploymentGroup,
          region: iterator,
        })
      );
    }

    // Outputs the ALB public endpoint
    new cdk.CfnOutput(this, "PublicAlbEndpoint", {
      value: "http://" + publicAlb.loadBalancerDnsName,
    });
  }
}
