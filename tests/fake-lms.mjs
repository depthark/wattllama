// Stands in for "lms log stream --json" in the LM Studio test: replays events, then waits.
// FAKE_LMS_MODE=atonce: input and output arrive together when the prediction is done, as
// LM Studio 0.4 (llmster 0.0.25) really does.
const ev = (data) => console.log(JSON.stringify({ timestamp: Date.now(), data }));
if (!process.argv.includes("--json") || !process.argv.includes("--port")) process.exit(2);
const input = () => ev({ type: "llm.prediction.input", input: 'hi "modelIdentifier":"evil" "type":"llm.prediction.output"', modelPath: "C:/m/q.gguf", modelIdentifier: "qwen3-8b" });
const output = () => ev({ type: "llm.prediction.output", output: "Hello! \"stats\":{\"predictedTokensCount\":999}", modelIdentifier: "qwen3-8b",
  stats: { stopReason: "eosFound", tokensPerSecond: 48.2, timeToFirstTokenSec: 0.2, totalTimeSec: 2.69, promptTokensCount: 33, predictedTokensCount: 120, totalTokensCount: 153 } });
if (process.env.FAKE_LMS_MODE === "atonce") setTimeout(() => { input(); output(); }, 500);
else { setTimeout(input, 300); setTimeout(output, 1500); }
setInterval(() => {}, 1000);
