/**
 * Skills repo prompt template for agents.
 * Skills are cloned into .skills folder inside main repo for relative path access.
 * NOTE: Skill files are already listed in codebase_tree - no need for 'ls' command.
 */
import { getConfig } from "@openswe/shared/dynamic-config";

export const SKILLS_REPO_PROMPT_TEMPLATE = `
    <skills_repository>
        <location>.skills/{SKILLS_SUBFOLDER}</location>
        <priority>CRITICAL - Must read BEFORE any other context gathering</priority>
        <files_listed_in>codebase_tree (no need to run 'ls')</files_listed_in>
        <instructions>
            Skills folder contains project-specific documentation and coding guidelines that you MUST follow.
            Files are already listed in codebase_tree under .skills/ - look for "_:" arrays containing filenames.
            Scan the file names and read files RELEVANT to the current task.
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
        - **DO NOT view directory** - filenames are already visible in codebase_tree, directly read the files
        - **ALWAYS read**: coding-standards/SKILL.md (mandatory for all tasks)
        - **If backend task** (API, NestJS, services, *-api projects): Also read backend-patterns/SKILL.md
        - **Also read** any \`<project-name>.md\` skill file matching the project you're working in (e.g., urcard-integration-api.md for urcard-integration-api project)
        - **Directly read skill files** (no directory listing): view path=".skills/{SKILLS_SUBFOLDER}/<filename>.md"`;

/**
 * Get the skills repo prompt section - only returns content if configured via env vars or dynamic config.
 * @param subfolderPath Optional subfolder path override.
 */
export function getSkillsRepoPrompt(subfolderPath?: string): string {
    const envOwner = getConfig("SKILLS_REPOSITORY_OWNER");
    const envRepo = getConfig("SKILLS_REPOSITORY_NAME");
    const envPath = getConfig("SKILLS_REPOSITORY_PATH")?.trim();

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
    const envOwner = getConfig("SKILLS_REPOSITORY_OWNER");
    const envRepo = getConfig("SKILLS_REPOSITORY_NAME");
    const envPath = getConfig("SKILLS_REPOSITORY_PATH")?.trim();

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
    return !!(getConfig("SKILLS_REPOSITORY_OWNER") && getConfig("SKILLS_REPOSITORY_NAME"));
}
