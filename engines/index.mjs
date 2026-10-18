// Engine adapters. Adding one = a new file here plus one line below (see CONTRIBUTING.md).
import * as llamacpp from "./llamacpp.mjs";
import * as ollama from "./ollama.mjs";

export const ENGINES = [llamacpp, ollama];
