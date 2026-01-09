

/**
 * Skills repo prompt template for agents.
 * Skills are cloned into .skills folder inside main repo for relative path access.
 */
export const SKILLS_REPO_PROMPT_TEMPLATE = `
    <skills_repository>
        <location>.skills/{SKILLS_SUBFOLDER}</location>
        <instructions>
            You have access to a skills folder at .skills/{SKILLS_SUBFOLDER} containing project-specific documentation and guidelines.
            
            **Check if relevant skill files exist that could help you understand the codebase or solve the task.**
            
            To read files from skills folder (use relative paths from repo root):
            - List available files: ls .skills/{SKILLS_SUBFOLDER}
            - View a file: view path=".skills/{SKILLS_SUBFOLDER}/<filename>.md"
        </instructions>
    </skills_repository>`;

/**
 * Skills first step template for Planner's context gathering phase.
 */
export const SKILLS_FIRST_STEP_TEMPLATE = `
    0. **CHECK .skills FOLDER FIRST**: Before exploring the main codebase, list and review relevant files in the .skills folder.
        - Run: ls .skills/{SKILLS_SUBFOLDER}
        - Read relevant skill files using relative paths: view path=".skills/{SKILLS_SUBFOLDER}/<filename>.md"
        - Skills contain project-specific guidelines and documentation that help you understand the codebase better.`;

/**
 * Get the skills repo prompt section - only returns content if configured via env vars.
 * @param subfolderPath Optional subfolder path override.
 */
export function getSkillsRepoPrompt(subfolderPath?: string): string {
    const envOwner = process.env.SKILLS_REPOSITORY_OWNER;
    const envRepo = process.env.SKILLS_REPOSITORY_NAME;
    const envPath = process.env.SKILLS_REPOSITORY_PATH?.trim();

    if (envOwner && envRepo) {
        const skillsSubfolder = subfolderPath ?? envPath ?? "";
        return SKILLS_REPO_PROMPT_TEMPLATE.replaceAll("{SKILLS_SUBFOLDER}", skillsSubfolder);
    }

    return "";
}

/**
 * Get the skills first step prompt for Planner.
 */
export function getSkillsFirstStep(subfolderPath?: string): string {
    const envOwner = process.env.SKILLS_REPOSITORY_OWNER;
    const envRepo = process.env.SKILLS_REPOSITORY_NAME;
    const envPath = process.env.SKILLS_REPOSITORY_PATH?.trim();

    if (envOwner && envRepo) {
        const skillsSubfolder = subfolderPath ?? envPath ?? "";
        return SKILLS_FIRST_STEP_TEMPLATE.replaceAll("{SKILLS_SUBFOLDER}", skillsSubfolder);
    }

    return "";
}

/**
 * Helper to check if skills repo is configured.
 */
export function isSkillsRepoConfigured(): boolean {
    return !!(process.env.SKILLS_REPOSITORY_OWNER && process.env.SKILLS_REPOSITORY_NAME);
}
