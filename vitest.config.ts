import { defineConfig } from 'vitest/config';
import path from 'node:path';

// 单元测试跑在普通 Node 里（没有 Electron 运行时），所以把 `electron` 这个模块
// 换成一个替身：只提供主进程代码在“导入期”和“纯逻辑路径”上真正用到的那几个 API。
export default defineConfig({
  resolve: {
    alias: {
      electron: path.resolve(process.cwd(), 'tests/stubs/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // 数据库测试会写临时目录，串行跑更稳
    fileParallelism: false
  }
});
