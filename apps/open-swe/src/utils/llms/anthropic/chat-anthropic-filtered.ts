/**
 * Custom ChatAnthropic wrapper that filters out invalid top_k and top_p values
 * before sending to the API.
 * 
 * LangChain SDK uses -1 as a sentinel value for "not set", but this causes
 * "invalid value: integer `-1`, expected u32" errors when sent to Anthropic API
 * through proxies that don't filter these values.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { AnthropicInput, ChatAnthropicCallOptions } from "@langchain/anthropic";

export class ChatAnthropicFiltered extends ChatAnthropic {
    /**
     * Override invocationParams to filter out sentinel values (-1) for top_k and top_p
     */
    invocationParams(
        options?: this["ParsedCallOptions"]
    ) {
        // Call parent's invocationParams
        const params = super.invocationParams(options);

        // Filter out sentinel values that Anthropic API doesn't accept
        // top_k: -1 means "not set" in LangChain but causes API error
        if ('top_k' in params && (params as any).top_k === -1) {
            delete (params as any).top_k;
        }

        // top_p: -1 means "not set" in LangChain but causes API error  
        if ('top_p' in params && (params as any).top_p === -1) {
            delete (params as any).top_p;
        }

        return params;
    }
}

export type { AnthropicInput, ChatAnthropicCallOptions };
