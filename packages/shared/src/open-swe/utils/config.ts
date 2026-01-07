import {
  GraphConfig,
  GraphConfigurationMetadata,
} from "@openswe/shared/open-swe/types";
import {
  GITHUB_USER_LOGIN_HEADER,
  GITHUB_USER_ID_HEADER,
  GITHUB_INSTALLATION_ID,
  GITHUB_INSTALLATION_NAME,
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_PAT,
} from "@openswe/shared/constants";

// Hidden fields that should still be passed through to subgraphs
const PASSTHROUGH_HIDDEN_FIELDS = [
  "apiKeys",
  "reviewPullNumber",
  "customFramework",
  GITHUB_USER_LOGIN_HEADER,
  GITHUB_USER_ID_HEADER,
  GITHUB_INSTALLATION_ID,
  GITHUB_INSTALLATION_NAME,
  GITHUB_TOKEN_COOKIE,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
  GITHUB_PAT,
];

export function getCustomConfigurableFields(
  config: GraphConfig,
): Partial<GraphConfig["configurable"]> {
  if (!config.configurable) return {};

  const result: Partial<GraphConfig["configurable"]> = {};

  for (const [key, metadataValue] of Object.entries(
    GraphConfigurationMetadata,
  )) {
    if (key in config.configurable) {
      if (
        metadataValue.x_open_swe_ui_config.type !== "hidden" ||
        PASSTHROUGH_HIDDEN_FIELDS.includes(key)
      ) {
        result[key as keyof GraphConfig["configurable"]] =
          config.configurable[key as keyof GraphConfig["configurable"]];
      }
    }
  }

  return result;
}
