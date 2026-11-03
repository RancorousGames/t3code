import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import "./mori.css";
import { MoriApp } from "./MoriApp.tsx";

if (window.moriBackend) document.documentElement.classList.add("mori-desktop");

const root = document.getElementById("root");
if (!root) throw new Error("Missing Monku root");
createRoot(root).render(
  <StrictMode>
    <MoriApp />
  </StrictMode>,
);
