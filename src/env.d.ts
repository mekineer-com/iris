declare module "*.css"
declare module "*.png" { const src: string; export default src }

declare const process: {
  env: Record<string, string | undefined>
}
