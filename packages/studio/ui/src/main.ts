import { Router } from "sv-router";
import { mount } from "svelte";
import { legacyPath } from "./lib/legacy-url";
import "./router";
import "./app.css";

const upgraded = legacyPath(new URL(location.href));
if (upgraded) history.replaceState(history.state, "", upgraded);

mount(Router, { target: document.getElementById("app")! });
