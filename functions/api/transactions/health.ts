import type { Env } from "../../lib/types";

export const onRequestGet: PagesFunction<Env> = async () => {
  return Response.json({ status: "ok" });
};
