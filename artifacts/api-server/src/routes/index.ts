import { Router, type IRouter } from "express";
import healthRouter from "./health";
import zaraRouter from "./zara";
import downloadRouter from "./download";
import { createRepairRouter } from "../repair/repair-router";
import { MemoryRepairIncidentStore } from "../repair/store";

const router: IRouter = Router();
const repairRouter = createRepairRouter({
  store: new MemoryRepairIncidentStore(),
  workerToken: () => process.env["ZARA_REPAIR_WORKER_TOKEN"],
  repoRoot: process.cwd(),
  trustRenderProxy: Boolean(process.env["RENDER_SERVICE_ID"]?.trim()),
});

router.use(healthRouter);
router.use(zaraRouter);
router.use(downloadRouter);
router.use(repairRouter);

export default router;
