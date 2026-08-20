'use strict';
// Regression coverage for the user-facing OpenRouter model/chat layer.
const assert = require('assert');
const { DEFAULT_OPENROUTER_SYNTHESIS_MODEL, resolveSynthesisModel, selectOpenRouterModels, buildGroundedChatRequest, reasoningForModel, consumeOpenRouterSse, classifyChatFailure } = require('./cli-lib.js');

const models = [
  { id: 'acme/vision', name: 'Vision', architecture: { output_modalities: ['image'] }, supported_parameters: [] },
  { id: 'deepseek/flash', name: 'DeepSeek Flash', architecture: { output_modalities: ['text'] }, supported_parameters: ['reasoning'], reasoning: { supported_efforts: ['high', 'low'], default_effort: 'low' } },
  { id: 'openai/mini', name: 'Mini', architecture: { output_modalities: ['text'] }, supported_parameters: ['temperature'] },
];

const found = selectOpenRouterModels(models, 'deepseek', 5);
assert.deepStrictEqual(found.map((m) => m.id), ['deepseek/flash']);
assert.strictEqual(DEFAULT_OPENROUTER_SYNTHESIS_MODEL, 'deepseek/deepseek-v4-flash-0731');
assert.strictEqual(resolveSynthesisModel({ llm: { model: 'anthropic/claude-3.5-haiku' } }), DEFAULT_OPENROUTER_SYNTHESIS_MODEL);
assert.strictEqual(resolveSynthesisModel({ llm: { model: 'deepseek/custom', modelSelected: true } }), 'deepseek/custom');

assert.deepStrictEqual(reasoningForModel(models[1], 'high'), { effort: 'high', exclude: true });
assert.strictEqual(reasoningForModel(models[1], 'medium'), null);

const request = buildGroundedChatRequest('Who is Kruti?', [
  { score: 0.9, text: 'Kruti is a researcher.' },
  { score: 0.7, text: 'Kruti works on memory systems.' },
], { model: 'deepseek/flash', temperature: 0.2, maxTokens: 300, thinking: 'high' }, models[1]);
assert.strictEqual(request.model, 'deepseek/flash');
assert.strictEqual(request.stream, true);
assert.strictEqual(request.temperature, 0.2);
assert.deepStrictEqual(request.reasoning, { effort: 'high', exclude: true });
assert.match(request.messages[0].content, /insufficient evidence/i);
assert.match(request.messages[0].content, /only mention a person or allegation/i);
assert.match(request.messages[1].content, /\[1\] Kruti is a researcher\./);
assert.match(request.messages[1].content, /Who is Kruti\?/);

const streamed = [];
let remainder = consumeOpenRouterSse('data: {"choices":[{"delta":{"content":"Hel', (token) => streamed.push(token));
assert.match(remainder, /Hel$/);
remainder = consumeOpenRouterSse(remainder + 'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"}}]}\r\ndata: [DONE]\r\n', (token) => streamed.push(token));
assert.strictEqual(remainder, '');
assert.deepStrictEqual(streamed, ['Hello', ' world']);

const geminiStyle = [];
remainder = consumeOpenRouterSse('data: {"choices":[{"delta":{"content":[{"type":"text","text":"Grounded"}]}}]}\n\ndata: {"choices":[{"delta":{"text":" answer"}}]}\n\n', (token) => geminiStyle.push(token));
assert.strictEqual(remainder, '');
assert.deepStrictEqual(geminiStyle, ['Grounded', ' answer']);

let streamError = null;
consumeOpenRouterSse('data: {"error":{"code":429,"message":"provider capacity exhausted"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n', () => {}, (message) => { streamError = message; });
assert.strictEqual(streamError, 'provider capacity exhausted');

assert.deepStrictEqual(classifyChatFailure(new Error('OpenRouter chat stream error: Gemini blocked the request: PROHIBITED_CONTENT')), {
  kind: 'provider-policy',
  message: 'provider safety policy blocked synthesis — local recall completed; inspect the recalled evidence above',
});
assert.deepStrictEqual(classifyChatFailure(new Error('OpenRouter returned no chat content from google/gemini')), {
  kind: 'provider-empty-response',
  message: 'provider completed without usable text — local recall completed; try again or choose another model with /model',
});
console.log('LLM_CHAT_OK');
