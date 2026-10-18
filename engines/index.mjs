// Engine adapters. Adding one = a new file here plus one line below (see CONTRIBUTING.md).
import * as llamacpp from "./llamacpp.mjs";
import * as ollama from "./ollama.mjs";
import * as lmstudio from "./lmstudio.mjs";

export const ENGINES = [llamacpp, ollama, lmstudio];
