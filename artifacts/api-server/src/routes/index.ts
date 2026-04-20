import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pingRouter from "./ping";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pingRouter);

export default router;
