import { Sandbox } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "./logger.js";
import { TIMEOUT_SEC } from "@openswe/shared/constants";

const logger = createLogger(LogLevel.DEBUG, "EnvSetup");

const VENV_PATH = ".venv";
const RUN_PYTHON_IN_VENV = `${VENV_PATH}/bin/python`;
const RUN_PIP_IN_VENV = `${VENV_PATH}/bin/pip`;

/**
 * Setup Python environment with requirements.txt + ruff + mypy
 */
export async function setupEnv(
  sandbox: Sandbox,
  absoluteRepoDir: string,
): Promise<boolean> {
  logger.info("[DAYTONA] Setting up Python environment...", {
    sandboxId: sandbox.id,
    sandboxState: sandbox.state,
    absoluteRepoDir,
  });

  const createVenvCommand = "python -m venv .venv";
  logger.debug("[DAYTONA] Creating virtual environment", {
    sandboxId: sandbox.id,
    command: createVenvCommand,
    workdir: absoluteRepoDir,
  });

  const startTime = Date.now();
  const createVenvRes = await sandbox.process.executeCommand(
    createVenvCommand,
    absoluteRepoDir,
    undefined,
    TIMEOUT_SEC,
  );

  logger.debug("[DAYTONA] Create venv response", {
    sandboxId: sandbox.id,
    command: createVenvCommand,
    durationMs: Date.now() - startTime,
    exitCode: createVenvRes.exitCode,
    result: createVenvRes.result?.substring(0, 500),
  });

  if (createVenvRes.exitCode !== 0) {
    logger.error("[DAYTONA] Failed to create virtual environment", {
      sandboxId: sandbox.id,
      createVenvCommand,
      createVenvRes: JSON.stringify(createVenvRes),
    });
    return false;
  }

  const upgradePipCommand = `${RUN_PIP_IN_VENV} install --upgrade pip`;
  logger.debug("[DAYTONA] Upgrading pip", {
    sandboxId: sandbox.id,
    command: upgradePipCommand,
  });

  const upgradePipStartTime = Date.now();
  const upgradePipRes = await sandbox.process.executeCommand(
    upgradePipCommand,
    absoluteRepoDir,
    undefined,
    TIMEOUT_SEC,
  );

  logger.debug("[DAYTONA] Upgrade pip response", {
    sandboxId: sandbox.id,
    durationMs: Date.now() - upgradePipStartTime,
    exitCode: upgradePipRes.exitCode,
    result: upgradePipRes.result?.substring(0, 500),
  });

  if (upgradePipRes.exitCode !== 0) {
    logger.warn("[DAYTONA] Failed to upgrade pip, continuing anyway", {
      sandboxId: sandbox.id,
      upgradePipRes: JSON.stringify(upgradePipRes),
    });
  }

  const checkRequirementsCommand = "test -f requirements.txt";
  logger.debug("[DAYTONA] Checking for requirements.txt", {
    sandboxId: sandbox.id,
    command: checkRequirementsCommand,
  });

  const requirementsExistRes = await sandbox.process.executeCommand(
    checkRequirementsCommand,
    absoluteRepoDir,
    undefined,
    TIMEOUT_SEC,
  );

  logger.debug("[DAYTONA] Requirements.txt check response", {
    sandboxId: sandbox.id,
    exitCode: requirementsExistRes.exitCode,
    exists: requirementsExistRes.exitCode === 0,
  });

  if (requirementsExistRes.exitCode === 0) {
    logger.info("[DAYTONA] Found requirements.txt, installing...", {
      sandboxId: sandbox.id,
    });

    const installReqCommand = `${RUN_PIP_IN_VENV} install -r requirements.txt`;
    const installReqStartTime = Date.now();
    const installReqRes = await sandbox.process.executeCommand(
      installReqCommand,
      absoluteRepoDir,
      undefined,
      TIMEOUT_SEC * 3,
    );

    logger.debug("[DAYTONA] Install requirements response", {
      sandboxId: sandbox.id,
      command: installReqCommand,
      durationMs: Date.now() - installReqStartTime,
      exitCode: installReqRes.exitCode,
      resultLength: installReqRes.result?.length,
      resultPreview: installReqRes.result?.substring(0, 500),
    });

    if (installReqRes.exitCode !== 0) {
      logger.warn(
        "[DAYTONA] Failed to install requirements.txt, continuing anyway",
        {
          sandboxId: sandbox.id,
          installReqRes: JSON.stringify(installReqRes).substring(0, 1000),
        },
      );
    }
  } else {
    logger.info(
      "[DAYTONA] No requirements.txt found, skipping repository dependencies",
      {
        sandboxId: sandbox.id,
      },
    );
  }

  const installToolsCommand = `${RUN_PIP_IN_VENV} install ruff mypy`;
  logger.debug("[DAYTONA] Installing analysis tools (ruff, mypy)", {
    sandboxId: sandbox.id,
    command: installToolsCommand,
  });

  const installToolsStartTime = Date.now();
  const installAnalysisToolsRes = await sandbox.process.executeCommand(
    installToolsCommand,
    absoluteRepoDir,
    undefined,
    TIMEOUT_SEC,
  );

  logger.debug("[DAYTONA] Install analysis tools response", {
    sandboxId: sandbox.id,
    durationMs: Date.now() - installToolsStartTime,
    exitCode: installAnalysisToolsRes.exitCode,
    result: installAnalysisToolsRes.result?.substring(0, 500),
  });

  if (installAnalysisToolsRes.exitCode !== 0) {
    logger.error("[DAYTONA] Failed to install ruff and mypy", {
      sandboxId: sandbox.id,
      installAnalysisToolsRes: JSON.stringify(installAnalysisToolsRes),
    });
    return false;
  }

  logger.info("[DAYTONA] Environment setup completed successfully", {
    sandboxId: sandbox.id,
  });
  return true;
}

/**
 * Export the constants for use in other files
 */
export const ENV_CONSTANTS = {
  VENV_PATH,
  RUN_PYTHON_IN_VENV,
  RUN_PIP_IN_VENV,
};
