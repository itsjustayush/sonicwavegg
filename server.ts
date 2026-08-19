import "dotenv/config";
import { createApp } from "./server/_core/app";

// Vercel discovers this default-exported Express app as one serverless function.
// Static Vite assets are copied to public/ during the Vercel build and served by its CDN.
export default createApp();
