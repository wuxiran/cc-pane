// lucideSolidShim 从深路径取 lucide 原件（"lucide-react" 本身已被别名指向 shim）。
// 深路径没有自带声明，类型与包入口相同。
declare module "lucide-react/dist/esm/lucide-react.js" {
  export * from "lucide-react";
}
