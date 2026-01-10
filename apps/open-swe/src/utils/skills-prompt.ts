/**
 * Skills repo prompt template for agents.
 * Skills are cloned into .skills folder inside main repo for relative path access.
 * NOTE: Skill files are already listed in codebase_tree - no need for 'ls' command.
 */
export const SKILLS_REPO_PROMPT_TEMPLATE = `
    <skills_repository>
        <location>.skills/{SKILLS_SUBFOLDER}</location>
        <files_listed_in>codebase_tree (no need to run 'ls')</files_listed_in>
        <instructions>
            Skills folder contains project-specific documentation and coding guidelines.
            Files are already listed in codebase_tree under .skills/ - look for "_:" arrays containing filenames.
            To read a skill file: view path=".skills/{SKILLS_SUBFOLDER}/<filename>.md"
        </instructions>
    </skills_repository>`;

/**
 * Skills first step template for Planner's context gathering phase.
 * NOTE: Files are already in codebase_tree - no need for 'ls' command.
 */
export const SKILLS_FIRST_STEP_TEMPLATE = `
    0. **CHECK .skills FOLDER FIRST**: Skills contain project-specific guidelines crucial for understanding the codebase.
        - Skill files are already listed in codebase_tree under .skills/ (look for "_:" arrays)
        - Read relevant skill files: view path=".skills/{SKILLS_SUBFOLDER}/<filename>.md"`;

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
