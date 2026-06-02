declare var process: any;
declare module 'node:fs' { const x:any; export default x; export = x; }
declare module 'node:path' { const x:any; export default x; export = x; }
declare module 'node:crypto' { const x:any; export default x; export = x; }
declare module 'node:url' { export const fileURLToPath:any; }
declare module 'node:http' { export type Server = any; }
declare module '*.css' {}
interface ImportMeta { env: Record<string, string | undefined>; url: string }
declare module 'vite' { export const defineConfig:any; }
declare module '@vitejs/plugin-react' { const react:any; export default react; }
declare module 'electron' { export const app:any; export const BrowserWindow:any; export const contextBridge:any; }
declare namespace React { export type ReactNode = any; }
declare module 'react' { export type FormEvent<T=any> = any; export function createContext<T=any>(v?:T): any; export function useContext<T=any>(v:any): T; export function useEffect(cb:any,deps?:any[]): void; export function useMemo<T=any>(cb:()=>T,deps?:any[]): T; export function useState<T=any>(v:T|(()=>T)): [T,(v:T|((old:T)=>T))=>void]; export const StrictMode:any; const React:any; export default React; }
declare module 'react/jsx-runtime' { export const jsx:any; export const jsxs:any; export const Fragment:any; }
declare namespace JSX { interface IntrinsicElements { [elemName: string]: any } }
declare module 'react-dom/client' { export const createRoot:any; }
declare module 'react-router-dom' { export const BrowserRouter:any; export const Navigate:any; export const NavLink:any; export const Outlet:any; export const Route:any; export const Routes:any; export const useLocation:any; export const useNavigate:any; }
declare module 'lucide-react' { export const Bell:any; export const Database:any; export const Server:any; export const Shield:any; }
declare module 'cors' { const cors:any; export default cors; }
declare module 'bcryptjs' { const bcrypt:any; export default bcrypt; }
declare module 'better-sqlite3' { namespace Database { export type Database = any } const Database:any; export default Database; }
declare module 'multer' { const multer:any; export default multer; }
declare module 'archiver' { const archiver:any; export default archiver; }
declare module 'express' { namespace express { export type Request=any; export type Response=any; export type NextFunction=any; } const express:any; export default express; export const Router:any; export type Request=any; export type Response=any; export type NextFunction=any; }
