import { App } from "./app.js";
import { registry, runtimeReady } from "./runtime.js";

if (runtimeReady) registry.register("hermes-ai-office", App);
