import "dotenv/config";
import { analyze } from "../server/analysis";
import { parseChat, toMessages } from "../shared/parser";
import { exampleText } from "../shared/fixtures";
const messages = toMessages(parseChat(exampleText(0)).messages, "我");
const result = await analyze({
  revision: 1,
  relation: "crush",
  messages,
  task: "overview",
  targetIds: [],
});
console.log(
  JSON.stringify(
    {
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
      overview: result.overview,
    },
    null,
    2,
  ),
);
