declare module "quick-format-unescaped" {
  export default function format(fmt: unknown, args: readonly unknown[], opts?: { stringify?: unknown }): string;
}
