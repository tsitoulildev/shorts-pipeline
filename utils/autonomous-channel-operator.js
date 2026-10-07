const { Logger } = require('./logger');

const PLAN_JOB_FIELDS = [
  'topic', 'idea', 'storyFamily', 'storyStructure', 'everydayAnchor', 'fearMechanism', 'angle', 'hook', 'scrollStopMoment',
  'visualWhy', 'visualVariety', 'curiosityAngle', 'escalationLadder', 'payoff', 'fitRationale', 'storyEngine',
  'autonomyRisk', 'nicheFit', 'visualStrength', 'curiosityGap', 'visualVarietyScore', 'retentionPotential',
  'originalityScore', 'brandFit', 'twistScore', 'premiseLegibility', 'payoffStrength', 'keywords', 'fictional'
];

// The planner's vetted idea travels with the job so the strategy stage does not
// throw away the chosen hook/payoff and regenerate a weaker one from the topic.
function pickPlanForJob(item) {
  if (!item || typeof item !== 'object') return null;
  const plan = {};
  for (const key of PLAN_JOB_FIELDS) {
    if (item[key] !== undefined && item[key] !== null) plan[key] = item[key];
  }
  return plan.topic ? plan : null;
}

class AutonomousChannelOperator {
  constructor(db, options = {}) {
    this.db = db;
    this.researchAndPlan = options.researchAndPlan;
    this.startGenerationJob = options.startGenerationJob;
    this.resumeGenerationJob = options.resumeGenerationJob;
    this.waitForGenerationJob = options.waitForGenerationJob;
    this.cancelGenerationJob = options.cancelGenerationJob || null;
    this.notify = options.notify || (async () => null);
    // Policy hooks: pause and human approval are independent of AUTONOMOUS_MODE.
    this.isAutomationPaused = options.isAutomationPaused || (async () => false);
    this.requiresHumanApproval = options.requiresHumanApproval || (async () =>
      String(process.env.AUTONOMOUS_MODE || '').toLowerCase() !== 'true');
    this.logger = new Logger('AutonomousOperator');
    this.activeRuns = new Map();
  }

  async start(strategy) {
    if (!strategy || strategy.status !== 'active') {
      const error = new Error('Save and activate a channel strategy before starting the autonomous operator');
      error.status = 409;
      throw error;
    }
    const active = await this.db.getActiveOperatorRun();
    if (active || this.activeRuns.size) {
      const error = new Error('An autonomous operator run is already active');
      error.status = 409;
      throw error;
    }

    const run = await this.db.createOperatorRun(strategy.id);
    const work = this.execute(run.id, strategy)
      .catch(error => this.logger.error(`Operator run ${run.id} failed:`, error))
      .finally(() => this.activeRuns.delete(run.id));
    this.activeRuns.set(run.id, work);
    return run;
  }

  async resume(runId, strategy) {
    const run = await this.db.getOperatorRun(runId);
    if (!run) {
      const error = new Error('Operator run not found');
      error.status = 404;
      throw error;
    }
    if (!['failed', 'interrupted', 'completed_with_issues'].includes(run.status)) {
      const error = new Error('Only failed or interrupted operator runs can be resumed');
      error.status = 409;
      throw error;
    }
    if (!strategy || strategy.status !== 'active') {
      const error = new Error('Activate the saved channel strategy before resuming this run');
      error.status = 409;
      throw error;
    }
    const active = await this.db.getActiveOperatorRun();
    if (active || this.activeRuns.size) {
      const error = new Error('An autonomous operator run is already active');
      error.status = 409;
      throw error;
    }
    await this.update(runId, {
      status: 'queued',
      stage: 'resuming',
      error: null,
      cancelRequested: false,
      completedAt: null
    });
    const work = this.execute(runId, strategy, { resume: true })
      .catch(error => this.logger.error(`Resumed operator run ${runId} failed:`, error))
      .finally(() => this.activeRuns.delete(runId));
    this.activeRuns.set(runId, work);
    return this.db.getOperatorRun(runId);
  }

  async execute(runId, strategy, options = {}) {
    try {
      const stored = options.resume ? await this.db.getOperatorRun(runId) : null;
      let research = stored?.research || {};
      let plan = stored?.plan || [];
      const generatedJobs = stored?.generatedJobs || [];
      await this.update(runId, {
        status: 'running',
        stage: plan.length ? 'resuming_plan' : 'researching',
        progress: plan.length ? Math.max(20, stored?.progress || 20) : 5,
        error: null,
        cancelRequested: false,
        completedAt: null
      });
      if (!plan.length) {
        ({ research, plan } = await this.researchAndPlan(strategy));
      }
      if (!plan.length) throw new Error('Research did not produce any usable content ideas');
      await this.assertNotCancelled(runId);
      await this.update(runId, { stage: 'planning', progress: 20, research, plan });

      const approvalRequired = await this.requiresHumanApproval();
      for (let index = 0; index < plan.length; index++) {
        await this.assertNotCancelled(runId);
        await this.assertNotPaused(runId);
        const item = plan[index];
        let record = generatedJobs[index];
        if (record?.status === 'completed') continue;
        let ideaId = record?.ideaId;
        if (!record) {
          const idea = await this.db.createContentIdea({
            topic: item.topic,
            angle: item.angle,
            style: item.format,
            status: 'generating',
            rationale: item.rationale
          });
          ideaId = idea.id;
          record = { jobId: null, ideaId, topic: item.topic, status: 'queued', planIndex: index };
          generatedJobs[index] = record;
        } else if (ideaId) {
          await this.db.updateContentIdea(ideaId, { status: 'generating' });
        }
        const progress = 20 + Math.round((index / plan.length) * 70);
        await this.update(runId, {
          stage: `producing_${index + 1}_of_${plan.length}`,
          progress,
          generatedJobs
        });

        try {
          await this.update(runId, { generatedJobs });
          await this.assertNotCancelled(runId);
          let job = record.jobId ? await this.db.getGenerationJob(record.jobId) : null;
          if (job && ['failed', 'interrupted'].includes(job.status)) {
            job = await this.resumeGenerationJob(job.id);
          } else if (!job || !['queued', 'running', 'completed'].includes(job.status)) {
            const selectedSourceUrls = new Set(item.sourceUrls || []);
            job = await this.startGenerationJob({
              topic: item.topic,
              style: item.format,
              length: item.length,
              source: 'autonomous_operator',
              strategyContext: {
                angle: item.angle,
                rationale: item.rationale,
                pillar: item.pillar,
                plan: pickPlanForJob(item),
                audience: strategy.audience,
                objective: strategy.objective,
                valueProposition: strategy.value_proposition,
                constraints: strategy.constraints,
                researchSources: (research.sourceCatalog || []).filter(source => selectedSourceUrls.has(source.url))
              }
            });
          }
          record.jobId = job.id;
          record.status = 'running';
          await this.update(runId, { generatedJobs });
          const completed = job.status === 'completed' ? job : await this.waitForGenerationJob(job.id);
          if (completed.status === 'interrupted' && completed.details?.pausedAt) {
            // The job stopped at a stage checkpoint because automation was paused;
            // keep its jobId so resuming the run resumes the job, not a new one.
            record.status = 'interrupted';
            await this.update(runId, { generatedJobs });
            const paused = new Error('Automation paused; the operator run will resume from its checkpoint');
            paused.code = 'OPERATOR_PAUSED';
            throw paused;
          }
          record.status = completed.status;
          record.productionId = completed.production_id || null;
          record.reviewStatus = completed.details?.reviewStatus || null;
          record.error = completed.error || null;
          if (!approvalRequired && ['needs_review', 'needs_attention'].includes(record.reviewStatus)) {
            record.status = 'failed';
            record.error = `Autonomous quality rejection: ${record.reviewStatus}`;
          }
          if (ideaId) await this.db.updateContentIdea(ideaId, {
            status: record.status === 'completed' ? 'generated' : 'failed'
          });
        } catch (error) {
          if (error.code === 'OPERATOR_PAUSED') throw error;
          record.status = error.code === 'OPERATOR_CANCELLED' ? 'cancelled' : 'failed';
          record.error = error.message;
          if (ideaId) await this.db.updateContentIdea(ideaId, { status: 'failed' });
          if (error.code === 'OPERATOR_CANCELLED') throw error;
        }
        await this.update(runId, {
          progress: 20 + Math.round(((index + 1) / plan.length) * 70),
          generatedJobs
        });
      }

      const completed = generatedJobs.filter(job => job.status === 'completed');
      const needsReview = approvalRequired
        ? completed.filter(job => ['needs_review', 'needs_attention'].includes(job.reviewStatus))
        : [];
      const failed = generatedJobs.filter(job => job.status !== 'completed');
      const allFailed = completed.length === 0 && failed.length > 0;
      const status = allFailed ? 'failed' : needsReview.length ? 'waiting_review' : failed.length ? 'completed_with_issues' : 'completed';
      const summary = {
        planned: plan.length,
        generated: completed.length,
        needsReview: needsReview.length,
        failed: failed.length
      };
      // Keep the real cause: the first failed item's error is what the owner (and the next session) must see.
      const cause = String(failed.find(job => job.error)?.error || 'no reason was recorded').replace(/\s+/g, ' ').slice(0, 300);
      await this.update(runId, {
        status,
        stage: allFailed ? 'failed' : needsReview.length ? 'waiting_for_review' : 'complete',
        progress: 100,
        generatedJobs,
        summary,
        error: allFailed ? `Every planned video failed during generation: ${cause}` : null,
        completedAt: new Date().toISOString()
      });
      if (allFailed) {
        // Never announce a run that produced nothing as "completed". The same cause repeats on every scheduler
        // tick, so the alert is sent once per cause per 6 hours.
        await this.notify({
          type: 'autonomous_run_failure',
          level: 'error',
          title: 'Autonomous run produced nothing',
          message: `0 of ${plan.length} planned videos were produced. Cause: ${cause}`,
          data: { runId, ...summary },
          dedupeKey: `autonomous_run_failure:${cause.slice(0, 80)}`,
          dedupeMinutes: 360
        });
      } else {
        await this.notify({
          type: 'autonomous_run_complete',
          level: failed.length ? 'warning' : 'success',
          title: needsReview.length ? 'Autonomous plan is ready for review' : 'Autonomous plan completed',
          message: `${completed.length} of ${plan.length} planned videos finished production.`,
          data: { runId, ...summary }
        });
      }
    } catch (error) {
      if (error.code === 'OPERATOR_PAUSED') {
        await this.update(runId, {
          status: 'interrupted',
          stage: 'paused',
          error: error.message,
          completedAt: new Date().toISOString()
        });
        await this.notify({
          type: 'autonomous_run_paused',
          level: 'info',
          title: 'Autonomous run paused',
          message: 'Automation is paused. Work stopped at a safe checkpoint and resumes when automation resumes.',
          data: { runId }
        });
        return;
      }
      const cancelled = error.code === 'OPERATOR_CANCELLED';
      await this.update(runId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'cancelled' : 'failed',
        error: error.message,
        completedAt: new Date().toISOString()
      });
      if (!cancelled) {
        await this.notify({
          type: 'autonomous_run_failure',
          level: 'error',
          title: 'Autonomous channel run failed',
          message: error.message,
          data: { runId }
        });
      }
      throw error;
    }
  }

  async cancel(runId) {
    const run = await this.db.getOperatorRun(runId);
    if (!run) return null;
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
    for (const item of run.generatedJobs) {
      const job = await this.db.getGenerationJob(item.jobId);
      if (job && ['queued', 'running'].includes(job.status)) {
        if (this.cancelGenerationJob) {
          await this.cancelGenerationJob(job.id, 'Autonomous operator stopped by the channel owner');
        } else {
          await this.db.updateGenerationJob(job.id, {
            cancelRequested: true,
            details: { cancelReason: 'Autonomous operator stopped by the channel owner' }
          });
        }
      }
    }
    return this.update(runId, { status: 'cancelling', cancelRequested: true });
  }

  async assertNotCancelled(runId) {
    const run = await this.db.getOperatorRun(runId);
    if (run?.cancelRequested) {
      const error = new Error('Autonomous operator stopped by the channel owner');
      error.code = 'OPERATOR_CANCELLED';
      throw error;
    }
  }

  async assertNotPaused(runId) {
    if (await this.isAutomationPaused()) {
      const error = new Error(`Automation paused before the next item of operator run ${runId}`);
      error.code = 'OPERATOR_PAUSED';
      throw error;
    }
  }

  update(runId, changes) {
    return this.db.updateOperatorRun(runId, changes);
  }
}

module.exports = { AutonomousChannelOperator, pickPlanForJob };
