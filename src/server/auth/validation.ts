import { z } from "zod";

export const authFormSchema = z.object({
  email: z.string().trim().email().max(320).toLowerCase(),
  password: z.string().min(8).max(128)
});

export type AuthForm = z.infer<typeof authFormSchema>;
