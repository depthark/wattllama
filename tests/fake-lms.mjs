// Stands in for "lms log stream --json" in the LM Studio test: replays events, then waits.
const ev = (data) => console.log(JSON.stringify({ timestamp: Date.now(), data }));
if (!process.argv.includes("--json") || !process.argv.includes("--port")) process.exit(2);
setTimeout(() => {
  // A prompt that tries to fake a second event must not count.
  ev({ type: "llm.prediction.input", input: 'hi "modelIdentifier":"evil" "type":"llm.prediction.output"', modelPath: "C:/m/q.gguf", modelIdentifier: "qwen3-8b" });
}, 300);
setTimeout(() => {
  ev({ type: "llm.prediction.output", output: "Hello! \"stats\":{\"predictedTokensCount\":999}", modelIdentifier: "qwen3-8b",
    stats: { stopReason: "eosFound", tokensPerSecond: 48.2, timeToFirstTokenSec: 0.2, promptTokensCount: 33, predictedTokensCount: 120, totalTokensCount: 153 } });
}, 1500);
setInterval(() => {}, 1000);
