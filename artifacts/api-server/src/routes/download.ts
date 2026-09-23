import { Router, type IRouter, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";

const router: IRouter = Router();
const apkFileName = "Zara-Assistant-1.0.1-release.apk";
const apkCandidates = [
  path.resolve(process.cwd(), apkFileName),
  path.resolve(process.cwd(), "artifacts", "zara-assistant", apkFileName),
  path.resolve(process.cwd(), "artifacts", "zara-assistant", "dist", apkFileName),
  path.resolve(process.cwd(), "..", "..", apkFileName),
];
const apkPath =
  apkCandidates.find((candidate) => fs.existsSync(candidate)) ??
  apkCandidates[0];

const sendApk = (_req: Request, res: Response) => {
  res.download(
    apkPath,
    apkFileName,
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=3600",
      },
    },
    (error) => {
      if (!error || res.headersSent) {
        return;
      }

      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "APK file not found." });
        return;
      }

      res.status(500).json({ error: "APK download failed." });
    },
  );
};

router.get("/download/zara-assistant-1.0.1-release.apk", sendApk);
router.get("/download/zara-assistant.apk", sendApk);

export default router;