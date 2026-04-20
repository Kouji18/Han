import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/ping", (_req, res) => {
  res.status(200).send("pong");
});

export default router;
