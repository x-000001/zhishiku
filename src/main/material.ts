/**
 * 第五版：窗口背景材质的状态。
 * 主进程建窗口时写进来，ipc 的 app:info 读出去，
 * 这样端到端自检能直接断言"Windows 11 上亚克力到底开没开"。
 *
 * 单独放一个模块是为了避免 index.ts 和 ipc.ts 互相 import。
 */

let material = 'none';

export function setBackgroundMaterialName(name: string): void {
  material = name;
}

export function backgroundMaterialName(): string {
  return material;
}
