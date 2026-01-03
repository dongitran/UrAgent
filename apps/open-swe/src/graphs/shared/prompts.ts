export const GITHUB_WORKFLOWS_PERMISSIONS_PROMPT = `
IMPORTANT: You have permissions to CREATE, EDIT, and DELETE files inside the GitHub workflows directory (.github/workflows/).
  - Workflow files MUST be created in \`.github/workflows/\` directory.
  - When creating or modifying workflows, you MUST use one or both of these triggers: \`workflow_dispatch\` (manual) or \`pull_request\` targeting \`main\` branch only.
  - NEVER create workflows with \`push\`, \`schedule\`, or other automatic triggers unless explicitly requested by the user.
`;
