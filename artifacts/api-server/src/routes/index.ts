import { Router, type IRouter } from "express";
import healthRouter from "./health";
import zaraRouter from "./zara";
import downloadRouter from "./download";

const router: IRouter = Router();

router.use(healthRouter);
router.use(zaraRouter);
router.use(downloadRouter);

export default router;
