import { WorkflowDefinition, WorkflowContext } from '../types';
import { WorkflowType } from '../types/workflow-type.enum';

export const contractDeploymentWorkflow: WorkflowDefinition = {
  type: WorkflowType.CONTRACT_DEPLOYMENT,
  name: 'Smart Contract Deployment',
  description: 'Deploy a smart contract and verify it on the blockchain',
  requiresCompensation: true,
  maxRetries: 3,
  steps: [
    {
      name: 'validate_contract_code',
      isIdempotent: true,
      maxRetries: 2,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(
          `Validating contract code for workflow: ${context.workflowId}`,
        );

        // Simulate contract validation
        const { contractCode, contractName } = input;

        if (!contractCode || !contractName) {
          throw new Error('Contract code and name are required');
        }

        // Simulate validation delay
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          isValid: true,
          validatedAt: new Date(),
          contractName,
          bytecode: '0x1234567890abcdef',
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating contract validation for workflow: ${context.workflowId}`,
        );
        // No compensation needed for validation step
        return Promise.resolve();
      },
    },
    {
      name: 'deploy_contract',
      isIdempotent: true,
      maxRetries: 3,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(`Deploying contract for workflow: ${context.workflowId}`);

        const validationOutput = context.metadata?.validate_contract_code;

        if (!validationOutput?.isValid) {
          throw new Error('Contract validation failed');
        }

        // Simulate contract deployment
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const contractAddress = `0x${Math.random().toString(16).substr(2, 40)}`;

        return {
          contractAddress,
          deploymentHash: `0x${Math.random().toString(16).substr(2, 64)}`,
          deployedAt: new Date(),
          gasUsed: 1500000,
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating contract deployment for workflow: ${context.workflowId}`,
        );

        if (output?.contractAddress) {
          // In a real implementation, this would interact with the blockchain
          // to mark the contract as invalid or trigger cleanup
          console.log(`Marking contract ${output.contractAddress} for cleanup`);
        }
        return Promise.resolve();
      },
    },
    {
      name: 'verify_contract',
      isIdempotent: true,
      maxRetries: 3,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(`Verifying contract for workflow: ${context.workflowId}`);

        const deploymentOutput = context.metadata?.deploy_contract;

        if (!deploymentOutput?.contractAddress) {
          throw new Error('Contract deployment failed');
        }

        // Simulate contract verification
        await new Promise((resolve) => setTimeout(resolve, 1500));

        return {
          contractAddress: deploymentOutput.contractAddress,
          verificationStatus: 'verified',
          verifiedAt: new Date(),
          explorerUrl: `https://etherscan.io/address/${deploymentOutput.contractAddress}`,
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating contract verification for workflow: ${context.workflowId}`,
        );

        if (output?.contractAddress) {
          // Remove verification from blockchain explorer
          console.log(
            `Removing verification for contract ${output.contractAddress}`,
          );
        }
        return Promise.resolve();
      },
    },
    {
      name: 'index_contract',
      isIdempotent: true,
      maxRetries: 2,
      execute: async (input: any, context: WorkflowContext) => {
        console.log(`Indexing contract for workflow: ${context.workflowId}`);

        const verificationOutput = context.metadata?.verify_contract;

        if (!verificationOutput?.contractAddress) {
          throw new Error('Contract verification failed');
        }

        // Simulate contract indexing
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          contractAddress: verificationOutput.contractAddress,
          indexedAt: new Date(),
          indexingStatus: 'completed',
          abiHash: '0xabcdef1234567890',
        };
      },
      compensate: (input: any, output: any, context: WorkflowContext) => {
        console.log(
          `Compensating contract indexing for workflow: ${context.workflowId}`,
        );

        if (output?.contractAddress) {
          // Remove from indexing service
          console.log(`Removing contract ${output.contractAddress} from index`);
        }
        return Promise.resolve();
      },
    },
  ],
};
