# vendor

`qrcode.js` —— [davidshimjs/qrcodejs](https://github.com/davidshimjs/qrcodejs)，MIT
（`LICENSE-qrcodejs`，© 2012 davidshimjs）。上游取自 `master` 的 `qrcode.js`。
它内部封装的编码器仍是 Kazuhiko Arase 的那套实现，头部保留了原始署名。

`package.json` 只有一行 `{"type":"commonjs"}`：本包外层是 `"type":"module"`，
不加这一层的话 `.js` 会被 Node 当 ESM 解析，Node 侧就 `require` 不进来。
有了它，vendor 文件能保留上游原本的 `.js` 名字，浏览器和 Node 共用同一份。

## 为什么带进来而不是加个 npm 依赖

2026-08-31 查过一轮，结论是**换成依赖并不能去掉下面那三处补丁**，只能省掉其中一处。

davidshimjs 本人从未发布到 npm。registry 上三个都是第三方镜像，2022 年发布后未再更新，
维护者与上游无关，都没有 `files` 字段（整仓打包 180KB，**包里带着 `jquery.min.js`** 和 demo HTML）：

| 包 | 仓库 | 与 GitHub master 的差异 |
|---|---|---|
| `qrcodejs2@0.0.2` | 指向 davidshimjs | 163 行（外层换成 UMD + 大量行尾空格噪音） |
| `davidshimjs-qrcodejs@0.0.2` | `makevoid/qrcodejs` | 2 行（只多了 `module.exports = QRCode`） |
| `qrcodejs@1.0.0` | `llyys/qrcodejs` | `main` 是 `module.exports = 'qrcodejs'`，一个字符串，不可用 |

三个在 Node 里都是**加载即抛** `document is not defined`，且都没有暴露编码器。所以：

- 补丁 1（`typeof document` guard）与补丁 2（暴露 `QRCodeModel` / `_getTypeNumber`）**躲不掉**
- 只有补丁 3（CJS 出口）能省 —— 镜像已经加了

改成依赖之后，补丁只是从这个版本控制里可见的文件，搬到 `patches/*.patch` + 安装期钩子；
而 airdrop-web 是**被别人依赖**的包，安装期补丁的声明与提升位置由消费方的包管理器决定，
依赖自己声明的补丁未必生效。综合下来维持 vendor：零依赖、补丁可见、不依赖安装期钩子。

如果哪天「能用 package 管」的优先级高于「必须是 qrcodejs」：`qrcode-generator@2.0.4`
（Arase 本人仓库，就是 qrcodejs 内部封装的同一套编码器，矩阵实测逐位一致）在 Node 里
直接可用、零依赖、MIT、带 ESM 与 d.ts，`createASCII` 与 `createSvgTag` 都现成 —— 零补丁。

## 三处补丁（都是追加式，上游其余部分逐字未动）

上游是**纯浏览器库**：`QRCode` 构造器要 DOM，也没有 ASCII 输出。而终端二维码只需要
模块矩阵。三处补丁就是为了让 Node 侧拿到矩阵，各自在文件里都有 `[airdrop patch N/3]` 标记。

1. **`var useSVG = ...` 前加 `typeof document !== "undefined"`。**
   这是整个文件唯一在**加载期**碰 DOM 的地方（`document.documentElement.tagName`）；
   不 guard 的话 Node 侧连 `require` 都进不来。其余 `document.createElement` 都在构造器
   或方法里，不影响加载。
2. **`QRCode.Model = QRCodeModel` / `QRCode.typeNumberFor = _getTypeNumber`。**
   编码器本体原本关在 IIFE 里出不来。终端侧用 `new QRCode.Model(type, level)` +
   `isDark()` / `getModuleCount()` 拿矩阵，完全不碰 DOM。
3. **CJS 出口。** 上游只往全局挂 `QRCode`。浏览器里 `typeof module` 是 undefined，这段不执行。

升级上游时这三处要重新贴一遍。判据是：`node -e "require('./qrcode.js')"` 不报错，
且 `QRCode.Model` / `QRCode.typeNumberFor` 都是函数。

## 两个上游行为，知道就好，没有改

- **每个码都比需要的大一号。** `_getUTF8Length()` 里
  `replacedText.length != sText` 拿**数字**跟**字符串**比，恒为真，所以长度永远多算 3。
  一个 26 字符的 ASCII URL 本可以用 type 2（25×25），实际会拿到 type 3（29×29）。
  没打补丁的理由：这属于改上游**逻辑**而不是暴露内部，一旦升级时漏贴，二维码会静默变尺寸；
  而多一号的码照样扫得出，代价只是密一点。要改的话就是把那半句改成 `replacedText != sText`。
- **`svgDrawer` 用了固定的 `id="template"`。** 同一页上有多个二维码时（空态下
  rail 的小图 + 空态大图 + 放大层就是三个），`<use xlink:href="#template">` 会解析到
  文档里第一个 `#template`。目前无害 —— 所有二维码的 `colorDark` / `colorLight` 都一样，
  画出来完全相同。**前提是各处颜色保持一致**；哪天要给某个二维码单独换色，这里会串味。
