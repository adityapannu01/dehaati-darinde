import { AccessToken } from 'livekit-server-sdk';
import { ChatOpenAI } from '@langchain/openai';
import { resolveGraphModel } from './config.ts';

// LiveKit Inference is an OpenAI-compatible HTTP gateway (agent-gateway.livekit.cloud),
// authenticated with a short-lived LiveKit JWT carrying an inference grant — the same
// LIVEKIT_API_KEY/SECRET already used everywhere else in this repo, no new credential.
// @livekit/agents drives it this way internally, but doesn't re-export the pieces
// (inference.createAccessToken is a type error), so this replicates the ~10 lines.
export const LK_INFERENCE_URL = 'https://agent-gateway.livekit.cloud/v1';

/**
 * Mints a short-lived JWT with an inference grant. Minting is local JWT
 * signing (no network round trip), so callers should mint one per turn
 * rather than caching and reasoning about expiry.
 */
export async function inferenceToken(ttl = 600): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      'graph: LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required to mint an inference token'
    );
  }
  const at = new AccessToken(apiKey, apiSecret, {
    identity: 'agent',
    ttl,
  });
  at.addInferenceGrant({ perform: true });
  return at.toJwt();
}

/** A LangChain chat model pointed at LiveKit Inference, on the same model/billing as TTS_PROVIDER's neighbours. */
export async function makeModel(model = resolveGraphModel()): Promise<ChatOpenAI> {
  return new ChatOpenAI({
    model,
    apiKey: await inferenceToken(),
    configuration: { baseURL: LK_INFERENCE_URL },
    streaming: true,
  });
}
