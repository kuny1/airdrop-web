#!/usr/bin/env node
/**
 * `airdrop` 独立入口。
 *
 * 这里只做一件事：把 argv 交给 `runAirdrop`，并把用户自己能修的错误打成一行消息 ——
 * 参数打错、端口被占，这类事不该被一屏调用栈淹掉。真正的 bug 照旧抛栈。
 */
import { runAirdrop, USAGE } from '../src/index.mjs';

try {
  await runAirdrop({ argv: process.argv.slice(2) });
} catch (e) {
  console.error(`\n✗ ${e.message}\n`);
  if (/不认识的参数|后面要跟一个值|端口不合法/.test(e.message)) console.error(USAGE + '\n');
  process.exit(1);
}
