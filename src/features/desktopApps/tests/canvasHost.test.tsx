// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewTabsHost } from "@/features/tabs/ViewTabsHost";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { boardKey, useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { addPortal, emptyBoard } from "@/features/canvas/board";

vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn().mockResolvedValue(undefined)}));
vi.mock("react-router-dom", () => ({useLocation:() => ({pathname:"/workspace"})}));
vi.mock("../GeminiDesktopTab", () => ({default:({active,canvas}:{active:boolean;canvas:boolean}) => <div data-gemini-active={String(active)} data-canvas={String(canvas)} />}));
vi.mock("@/features/tabs/layout/layoutStore", () => ({
  focusGroup:vi.fn(),
  usePlacements:() => ({visible:useCanvasStore.getState().modes[boardKey("/p")] === "canvas" ? new Map() : new Map([["v:g",{groupId:"group",rect:null}]]),focusedItem:"v:g"}),
  placeStyle:(rect: {left:number;top:number;width:number;height:number}|null) => rect ? {position:"absolute",left:rect.left,top:rect.top,width:rect.width,height:rect.height} : {position:"absolute",inset:0},
}));

let root:Root;
let host:HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  useTabsStore.getState().hydrateFromBackend([{id:"worker",cwd:"/p",title:"Worker",agentId:"codex",agentLabel:"Codex",command:"codex",ptyId:null,openedAt:0}]);
  useTabsStore.getState().activateTab("worker");
  useViewTabsStore.setState({views:[{id:"g",kind:"desktop",app:"gemini",cwd:"/p",title:"Gemini"}],activeViewId:"g",keepMountedIds:[]});
  const key=boardKey("/p");
  useCanvasStore.setState({boards:{[key]:addPortal(emptyBoard(),{id:"portal-g",kind:"gemini"}).board},modes:{[key]:"canvas"},desktopRects:{"portal-g":{left:50,top:90,width:800,height:500}},desktopFocus:null});
  host=document.createElement("div"); document.body.append(host);root=createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount());host.remove();});

it("uses the Gemini node rectangle in Canvas and keeps the same mounted panel when returning to tabs",async () => {
  await act(async () => {root.render(<ViewTabsHost />);});
  expect(useViewTabsStore.getState().activeViewId).toBeNull();
  expect(useCanvasStore.getState().desktopFocus).toMatchObject({key:boardKey("/p"),id:"portal-g"});
  const pane=host.querySelector<HTMLElement>('[data-view-key="v:g"]')!;
  expect(pane.style.left).toBe("50px");
  expect(pane.style.width).toBe("800px");
  expect(pane.querySelector("[data-canvas=true]")).not.toBeNull();
  await act(async () => {useCanvasStore.setState({modes:{[boardKey("/p")]:"tabs"}});useViewTabsStore.getState().activateView("g");});
  expect(host.querySelector('[data-view-key="v:g"]')).toBe(pane);
  expect(pane.style.inset).toBe("0");
  expect(pane.querySelector("[data-canvas=false]")).not.toBeNull();
});

it("hides the existing native panel when the Gemini node leaves the viewport",async () => {
  await act(async () => {root.render(<ViewTabsHost />);});
  await act(async () => {useCanvasStore.setState({desktopRects:{}});});
  expect(host.querySelector<HTMLElement>('[data-view-key="v:g"]')!.style.visibility).toBe("hidden");
  expect(host.querySelector('[data-gemini-active="false"]')).not.toBeNull();
});
