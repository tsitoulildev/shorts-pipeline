// The agents the service starts must have the methods the rest of the code calls: a missing one fails the start, not a Short at midnight.
class AgentContractService {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.version = '2.0';
  }

  validateAgentRegistry(agents = {}) {
    const required = {
      publishing: ['scheduleContent'],
      analytics: ['getRecentAnalytics']
    };
    const failures = [];
    for (const [name, methods] of Object.entries(required)) {
      const agent = agents[name];
      if (!agent) {
        failures.push(`${name}: missing agent`);
        continue;
      }
      for (const method of methods) {
        if (typeof agent[method] !== 'function') failures.push(`${name}.${method}: missing method`);
      }
    }
    if (failures.length) throw this.invalid(`Agent registry contract failed: ${failures.join('; ')}`);
    return { version: this.version, agents: Object.keys(required) };
  }

  invalid(message) {
    const error = new Error(`Agent communication contract: ${message}`);
    error.code = 'AGENT_CONTRACT_VIOLATION';
    error.status = 500;
    return error;
  }
}

module.exports = { AgentContractService };
