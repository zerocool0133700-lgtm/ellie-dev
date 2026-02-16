/**
 * Work Session API Routes
 *
 * Express routes for work session communication:
 * POST /api/work-session/start
 * POST /api/work-session/update
 * POST /api/work-session/decision
 * POST /api/work-session/complete
 */

import type { Request, Response, Router } from "express";
import {
  logWorkSessionStart,
  logWorkSessionUpdate,
  logWorkSessionDecision,
  completeWorkSession,
} from "../work-session";

/**
 * Register work session API routes
 */
export function registerWorkSessionRoutes(router: Router) {
  // POST /api/work-session/start
  router.post("/work-session/start", async (req: Request, res: Response) => {
    try {
      const { work_item_id, work_item_title, agent, repository, session_id, timestamp } = req.body;

      // Validate required fields
      if (!work_item_id || !work_item_title || !agent || !repository || !session_id) {
        return res.status(400).json({
          error: "Missing required fields: work_item_id, work_item_title, agent, repository, session_id",
        });
      }

      await logWorkSessionStart({
        work_item_id,
        work_item_title,
        agent,
        repository,
        session_id,
        timestamp: timestamp || new Date().toISOString(),
      });

      res.json({
        success: true,
        message: `Work session started for ${work_item_id}`,
        session_id,
      });
    } catch (error: any) {
      console.error("Error starting work session:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/work-session/update
  router.post("/work-session/update", async (req: Request, res: Response) => {
    try {
      const { session_id, work_item_id, timestamp, update_type, summary, details } = req.body;

      // Validate required fields
      if (!session_id || !work_item_id || !update_type || !summary) {
        return res.status(400).json({
          error: "Missing required fields: session_id, work_item_id, update_type, summary",
        });
      }

      // Validate update_type
      const validTypes = ["progress", "decision", "milestone", "blocker"];
      if (!validTypes.includes(update_type)) {
        return res.status(400).json({
          error: `Invalid update_type. Must be one of: ${validTypes.join(", ")}`,
        });
      }

      await logWorkSessionUpdate({
        session_id,
        work_item_id,
        timestamp: timestamp || new Date().toISOString(),
        update_type,
        summary,
        details,
      });

      res.json({
        success: true,
        message: `Work session updated (${update_type})`,
      });
    } catch (error: any) {
      console.error("Error updating work session:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/work-session/decision
  router.post("/work-session/decision", async (req: Request, res: Response) => {
    try {
      const {
        session_id,
        work_item_id,
        timestamp,
        decision,
        reasoning,
        alternatives_considered,
        impact,
      } = req.body;

      // Validate required fields
      if (!session_id || !work_item_id || !decision || !reasoning || !impact) {
        return res.status(400).json({
          error: "Missing required fields: session_id, work_item_id, decision, reasoning, impact",
        });
      }

      await logWorkSessionDecision({
        session_id,
        work_item_id,
        timestamp: timestamp || new Date().toISOString(),
        decision,
        reasoning,
        alternatives_considered,
        impact,
      });

      res.json({
        success: true,
        message: "Decision logged successfully",
      });
    } catch (error: any) {
      console.error("Error logging decision:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/work-session/complete
  router.post("/work-session/complete", async (req: Request, res: Response) => {
    try {
      const {
        session_id,
        work_item_id,
        timestamp,
        status,
        summary,
        deliverables,
        next_steps,
        time_spent_minutes,
      } = req.body;

      // Validate required fields
      if (!session_id || !work_item_id || !status || !summary) {
        return res.status(400).json({
          error: "Missing required fields: session_id, work_item_id, status, summary",
        });
      }

      // Validate status
      const validStatuses = ["completed", "blocked", "paused"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }

      await completeWorkSession({
        session_id,
        work_item_id,
        timestamp: timestamp || new Date().toISOString(),
        status,
        summary,
        deliverables,
        next_steps,
        time_spent_minutes,
      });

      res.json({
        success: true,
        message: `Work session completed with status: ${status}`,
      });
    } catch (error: any) {
      console.error("Error completing work session:", error);
      res.status(500).json({ error: error.message });
    }
  });
}
