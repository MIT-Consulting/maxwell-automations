import { z } from "zod";
import { triggerRunSchema } from "./run.js";

const nonEmptyString = z.string().trim().min(1);

export const enqueueFeatureSchema = z
  .strictObject({
    workspaceId: nonEmptyString,
    featureId: nonEmptyString,
    after: z
      .array(nonEmptyString)
      .optional()
      .default([])
      .superRefine((value, ctx) => {
        const seen = new Set<string>();
        for (let i = 0; i < value.length; i++) {
          const id = value[i]!;
          if (seen.has(id)) {
            ctx.addIssue({
              code: "custom",
              message: `duplicate after dependency: ${id}`,
              path: [i],
            });
          }
          seen.add(id);
        }
      }),
    kickoff: triggerRunSchema,
  })
  .superRefine((value, ctx) => {
    if (value.after.includes(value.featureId)) {
      ctx.addIssue({
        code: "custom",
        message: "after must not include the entry's own featureId",
        path: ["after"],
      });
    }
  });
