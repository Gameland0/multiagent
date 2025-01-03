const { ChatOpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const { LLMChain } = require("langchain/chains");
const { AgentExecutor, ZeroShotAgent } = require("langchain/agents");
const { Tool } = require("langchain/tools");
const OpenAIService = require('./openaiService');
const MessageProcessingService = require('./messageProcessingService')
// const { promisify } = require('util');
// const sleep = promisify(setTimeout);


class LangChainService {
  constructor() {
    this.llm = new ChatOpenAI({
      temperature: 0.4,
      modelName: "gpt-4o",
      openAIApiKey: process.env.OPENAI_API_KEY
    });
    this.tools = this.initializeTools();
    this.agentExecutor = this.initializeAgentExecutor();
    this.workflowTemplates = this.initializeWorkflowTemplates();
  }
  
  async createAgent(agentData) {
    const prompt = PromptTemplate.fromTemplate(
      `Create an AI agent with the following details:
      Name: {name}
      Role: {role}
      Goal: {goal}
      Description: {description}
      
      Provide a JSON object with the agent's capabilities and initial state.`
    );

    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.invoke(agentData);
    return JSON.parse(result.text);
  }

  async shouldDecomposeTask(message, context) {
    const prompt = PromptTemplate.fromTemplate(
      `Analyze the following message and determine if it requires task decomposition. 
      Consider the complexity and nature of the task. 
      If it's a simple request (like asking for a simple code snippet) or a follow-up to a previous decomposition, respond with 'No'. 
      Only respond with 'Yes' if it's a complex task that genuinely needs to be broken down into subtasks.
      
      Context: {context}
      Message: {message}
      
      Response (Yes/No):`
    );
  
    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.invoke({ context: context.join('\n'), message });
    return result.text.trim().toLowerCase() === 'yes';
  }

  async processSimpleMessage(message, team, context) {
    const prompt = PromptTemplate.fromTemplate(
      `You are an AI assistant for the team "{teamName}". Respond to the user's message in the context of the ongoing discussion.
      Context: {context}
      User message: {message}`
    );
  
    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ teamName: team.name, context: context.join('\n'), message });
    return result.text;
  }
  
  initializeTools() {
    return [
      new Tool({
        name: "CodeGenerator",
        description: "Generates code based on given specifications or requirements",
        func: async (input) => {
          try {
            const result = await this.llm.call([
              { role: "system", content: "You are a code generator. Generate code based on the given input." },
              { role: "user", content: input }
            ]);
            return result.content;
          } catch (error) {
            console.error("Error in CodeGenerator:", error);
            throw error;
          }
        }
      }),
      new Tool({
        name: "CodeReviewer",
        description: "Reviews code and suggests improvements or identifies issues",
        func: async (input) => {
          try {
            const result = await this.llm.call([
              { role: "system", content: "You are a code reviewer. Review the given code and provide feedback." },
              { role: "user", content: input }
            ]);
            return result.content;
          } catch (error) {
            console.error("Error in CodeReviewer:", error);
            throw error;
          }
        }
      }),
      new Tool({
        name: "SecurityAuditor",
        description: "Audits code for security vulnerabilities and suggests fixes",
        func: async (input) => {
          try {
            const result = await this.llm.call([
              { role: "system", content: "You are a security auditor. Analyze the given code for security vulnerabilities." },
              { role: "user", content: input }
            ]);
            return result.content;
          } catch (error) {
            console.error("Error in SecurityAuditor:", error);
            throw error;
          }
        }
      })
    ];
  }
  
  initializeAgentExecutor() {
    const prefix = `You are an Agent Executor managing a software development team. 
    Your role is to coordinate tasks, manage conflicts, and ensure smooth collaboration.
    You have access to the following tools:`;
    const suffix = `Break down complex tasks, assign them to appropriate team members, 
    manage task dependencies, and provide progress updates.`;

    const promptTemplate = ZeroShotAgent.createPrompt(this.tools, {
      prefix: prefix,
      suffix: suffix,
      inputVariables: ["input", "agent_scratchpad", "chat_history"]
    });

    const llmChain = new LLMChain({ llm: this.llm, prompt: promptTemplate });

    const agent = new ZeroShotAgent({
      llmChain,
      allowedTools: this.tools.map(tool => tool.name)
    });

    return new AgentExecutor({
      agent,
      tools: this.tools,
      returnIntermediateSteps: true,
      maxIterations: 5,
      verbose: true,
    });
  }

  initializeWorkflowTemplates() {
    return {
      "codeGeneration": ["CodeGenerator", "CodeReviewer", "SecurityAuditor"],
      // "bugFix": ["CodeReviewer", "CodeGenerator", "SecurityAuditor"],
    };
  }

  async executeTeamTask(task, context, workflowStep) {
    console.log(`Executing team task with workflow: ${workflowStep}`);
    const workflow = this.workflowTemplates[workflowStep] || this.workflowTemplates["codeGeneration"];
    console.log(`Selected workflow: ${workflow.join(' -> ')}`);
  
    let result = { intermediateSteps: [], finalOutput: '' };
  
    for (const step of workflow) {
      console.log(`Executing step: ${step}`);
      const tool = this.tools.find(t => t.name === step);
      if (tool) {
        try {
          const stepResult = await this.retryOperation(() => tool.func(task + "\n\nPrevious step output: " + result.finalOutput));
          result.intermediateSteps.push({ tool: step, output: stepResult });
          result.finalOutput += `\n${step} output: ${stepResult}`;
        } catch (error) {
          console.error(`Error in ${step}:`, error);
          result.intermediateSteps.push({ tool: step, output: `Error: ${error.message}` });
          result.finalOutput += `\n${step} error: ${error.message}`;
        }
      } else {
        console.warn(`Tool not found for step: ${step}`);
        result.intermediateSteps.push({ tool: step, output: 'Tool not found' });
        result.finalOutput += `\n${step}: Tool not found`;
      }
    }
  
    return result;
  }
  
  async handleConflict(conflict, context) {
    const prompt = PromptTemplate.fromTemplate(
      `Resolve the following conflict in the development process:
      Conflict: {conflict}
      Context: {context}
      Provide a resolution strategy and any necessary task reassignments.`
    );

    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ conflict, context: context.join('\n') });
    return result.text;
  }

  async assessTaskComplexity(task, context) {
    const promptTemplate = `
  Assess the complexity of the following task on a scale of 1-5, where 5 is most complex. 
  Also, recommend an appropriate workflow template based on the task nature.
  
  Task: {task}
  
  Context: {context}
  
  Available workflow templates: ${Object.keys(this.workflowTemplates).join(', ')}
  
  Provide your response in the following format:
  Complexity: [number between 1 and 5]
  Recommended Workflow: [one of the available workflow templates]
  `;
  
    const chain = new LLMChain({
      llm: this.llm,
      prompt: new PromptTemplate({
        template: promptTemplate,
        inputVariables: ["task", "context"]
      })
    });
  
    const result = await chain.call({ task, context: context.join('\n') });
    
    console.log("Raw LLM response:", result.text);  // 添加这行来查看原始响应
  
    // 解析响应
    const complexityMatch = result.text.match(/Complexity:\s*(\d+)/);
    const workflowMatch = result.text.match(/Recommended Workflow:\s*(\w+)/);
  
    if (!complexityMatch || !workflowMatch) {
      console.error('Failed to parse LLM response:', result.text);
      return { complexity: 3, recommendedWorkflow: "codeGeneration" };
    }
  
    return {
      complexity: parseInt(complexityMatch[1]),
      recommendedWorkflow: workflowMatch[1]
    };
  }

  async understandRequirements(task, context) {
    const contextArray = Array.isArray(context) ? context : [context];
  
    const contextString = contextArray
      .filter(c => c && typeof c === 'object' && c.content)
      .map(c => c.content)
      .join('\n');
  
    const messages = [
      {
        role: "system",
        content: "You are an AI assistant tasked with understanding and analyzing task requirements."
      },
      {
        role: "user",
        content: `Task: ${task}\n\nContext: ${contextString}\n\nPlease provide:\n1. A summary of the main requirements\n2. Any clarifying questions that need to be asked\n3. Potential challenges or considerations\n\nDo not start implementing or coding yet.`
      }
    ];
  
    const response = await this.llm.call(messages);
    return response.content;
  }  
  
  async retryOperation(operation, maxAttempts = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async processMessage(message, team, context,combinedKnowledge,blockchainPlatform) {
    const conversationId = context[0]?.conversationId;
    const conversationState = MessageProcessingService.getConversationState(conversationId);
    if (conversationState.isExplainingCode && 
      MessageProcessingService.isFollowUpQuestion(message, conversationState.lastCodeExplanation)) {
      return {
        needsDecomposition: false,
        response: `I understand your response to the code explanation. Let me know if you have any specific questions about the implementation.`,
        codeChanges: null
      };
    }

    const gameType = this.detectGameType(message);
    const coordinatorAgent = this.getCoordinatorAgent(team);
    const teamInfo = team.agents.map(a => ({ id: a.id, name: a.name, role: a.role, skills: a.skills || [] }));
    const existingCode = this.extractExistingCode(context);
    const taskDecompositionTemplate = this.getStandardTaskDecompositionTemplate();
    const userLanguage = MessageProcessingService.detectUserLanguage(message);
    const isSimpleRequest = await this.isSimpleRequest(message, context);
    const isGameDesignRelated = this.isGameDesignMessage(message);
    console.log('isGameDesignRelated:',isGameDesignRelated)
    const gameTypeDescription = gameType === 'fullChain' 
      ? 'implementing all logic on-chain' 
      : 'implementing core assets on-chain and game logic off-chain';

    let prompt
    if (isSimpleRequest) {
      prompt = PromptTemplate.fromTemplate(`
        As the {role}, you are managing a team working on a blockchain-based web game development project. 
        Provide a direct and concise response to the user's request based on the context.

        Previous conversation context:
        {context}

        Current user message: {message}

        Respond directly to the user's query without task decomposition or extensive explanations.
      `);
    } else if (isGameDesignRelated) {
      prompt = PromptTemplate.fromTemplate(`
      As the {role}, you are managing a team working on a {gameType} blockchain-based web game development project for {blockchainPlatform}. 
      Understand the user's request and provide an appropriate response based on the context. Respond in {userLanguage}.

      Team members information:
      {teamInfo}

      Previous conversation context:
      {context}

      Current user message: {message}

      {existingCode}

      Combined team knowledge:
      {combinedKnowledge}

      If the user is requesting a new feature or significant modification, decompose the task.
      If the request is related to existing features or minor modifications, provide a direct response.

      Respond in JSON format with the following structure:
      {{
        "needsDecomposition": boolean,
        "response": string,
        "gameDescription": {{
          "gameName": string,
          "concept": string,
          "objective": string,
          "gameplay": {{
            "exploration": string,
            "interaction": string,
            "progression": string,
            "challenges": string
          }},
          "smartContractFeatures": string[],
          "gameType": "{gameType}"
        }},
        "taskDecomposition": [{{ 
          "description": string, 
          "agentType": string,
          "requiredSkills": string[],
          "codeChanges": string,
          "expected_output": string
        }}] or null,
        "codeChanges": string or null
      }}

      Use this task decomposition template if needed:
      {taskDecompositionTemplate}

      Ensure your response is relevant to the ongoing conversation and the {blockchainPlatform} game development context.
      If code modification is needed, include the necessary changes in the 'codeChanges' field using the appropriate language for {blockchainPlatform}.
      For a {gameType} game, focus on ${gameTypeDescription}.
    `);

    } else {
      prompt = PromptTemplate.fromTemplate(`
      As the {role}, you are managing a team working on a blockchain-based web game development project for {blockchainPlatform}. 
      Understand the user's request and provide an appropriate response based on the context. Respond in {userLanguage}.

      Team members information:
      {teamInfo}

      Previous conversation context:
      {context}

      Current user message: {message}

      {existingCode}

      Combined team knowledge:
      {combinedKnowledge}

      If the user is requesting a new feature or significant modification, decompose the task.
      If the request is related to existing features or minor modifications, provide a direct response.

      Respond in JSON format with the following structure:
      {{
        "needsDecomposition": boolean,
        "response": string,
        "taskDecomposition": [{{ 
          "description": string, 
          "agentType": string,
          "requiredSkills": string[],
          "codeChanges": string,
          "expected_output": string
        }}] or null,
        "codeChanges": string or null
      }}

      Use this task decomposition template if needed:
      {taskDecompositionTemplate}

      Ensure your response is relevant to the ongoing conversation and the {blockchainPlatform} game development context.
      If code modification is needed, include the necessary changes in the 'codeChanges' field using the appropriate language for {blockchainPlatform}.
    ` );
    }
  
    const chain = new LLMChain({ llm: this.llm, prompt });

    const result = await chain.call({
      role: coordinatorAgent.role,
      gameType,
      blockchainPlatform,
      userLanguage,
      teamInfo: JSON.stringify(teamInfo, null, 2),
      context: context.map(msg => `${msg.sender}: ${msg.content}`).join('\n'),
      message,
      existingCode: existingCode ? `Existing code:\n${existingCode}` : "No existing code provided.",
      combinedKnowledge,
      taskDecompositionTemplate: JSON.stringify(taskDecompositionTemplate, null, 2),
      gameTypeDescription
    });

    if (result.taskDecomposition || result.codeChanges) {
      MessageProcessingService.setConversationState(conversationId, {
        isExplainingCode: true,
        lastCodeExplanation: result.response,
        lastDiscussedCode: result.codeChanges || existingCode
      });
    }

    let parsedResponse;
    try {
      if (isSimpleRequest) {
        return {
          needsDecomposition: false,
          response: result.text.trim(),
          codeChanges: null
        };
      }

      let cleanedResult = result.text.replace(/```json\s?|\s?```/g, '').trim();
      
      cleanedResult = cleanedResult.replace(/"response"\s*:\s*"(.*)"\s*\+\s*new Date\(\)\.toISOString\(\)/, (match, p1) => {
        return `"response": "${p1}${new Date().toISOString()}"`;
      });
      parsedResponse = JSON.parse(cleanedResult);
      // parsedResponse = this.customJSONParse(cleanedResult);

      // 检查是否真的需要任务分解
      // console.log('parsedResponse:',parsedResponse);
      if (typeof parsedResponse !== 'object' || parsedResponse === null) {
        throw new Error('Parsed response is not an object');
      }
      // console.log('parsedResponse:',parsedResponse)
      if (parsedResponse.gameDescription) {
        parsedResponse.response = this.formatGameDescription(parsedResponse.gameDescription) + "\n\n" + parsedResponse.response;
      }  

      //如果需要任务分解,为每个任务分配一个团队成员
      if (parsedResponse.taskDecomposition) {
        parsedResponse.taskDecomposition = parsedResponse.taskDecomposition.map(task => ({
          ...task,
          assignedAgentId: (team.agents.find(a => a.role.toLowerCase() === task.agentType.toLowerCase()) || team.agents[0]).id,
          model: (team.agents.find(a => a.role.toLowerCase() === task.agentType.toLowerCase()) || team.agents[0]).model,
          agentType: this.adjustAgentTypeForPlatform(task.agentType, blockchainPlatform),
          requiredSkills: this.adjustSkillsForPlatform(task.requiredSkills, blockchainPlatform)
        }));
      }

    } catch (error) {
      console.error('Error parsing LLM response:', error);
      throw new Error('Invalid response format');
    }

    return parsedResponse;
  }

  extractExistingCode(context) {
    const codeMessage = context.find(msg => msg.content.includes("contract"));
    if (codeMessage) {
      const codeMatch = codeMessage.content.match(/```solidity\n([\s\S]*?)```/);
      return codeMatch ? codeMatch[1] : null;
    }
    return null;
  }

  getCoordinatorAgent(team) {
    return team.agents.find(a => a.role.toLowerCase().includes('coordinator') || a.role.toLowerCase().includes('manager')) || {
      id: 'coordinator-' + team.id,
      name: 'Team Coordinator',
      role: 'Coordinator',
      description: 'Responsible for task assessment, decomposition, and assignment within the team.'
    };
  }

  formatGameDescription(gameDescription) {
    let response = `Game Name: ${gameDescription.gameName}\n\n`;
    response += `Game Concept: ${gameDescription.concept}\n\n`;
    response += `Game Objective: ${gameDescription.objective}\n\n`;
    response += "Gameplay: \n";
    for (const [key, value] of Object.entries(gameDescription.gameplay)) {
      response += `- ${value}\n`;
    }
    response += "\nSmart Contract Features:\n";
    gameDescription.smartContractFeatures.forEach(feature => {
      response += `- ${feature}\n`;
    });
    return response;
  }
  
  getDefaultSkillsForAgentType(role) {
    const defaultSkills = {
      'task_decomposer': ['task analysis', 'project planning', 'critical thinking'],
      'executor': ['task execution', 'problem-solving', 'time management'],
      'reviewer': ['code review', 'quality assurance', 'attention to detail'],
      'smartcontract_developer': ['smart contract development', 'blockchain protocols', 'security best practices', 'gas optimization'],
      'solidity_developer': ['solidity', 'ethereum development', 'evm', 'gas optimization'],
      'rust_developer': ['rust', 'solana development', 'anchor framework'],
      'move_developer': ['move', 'sui development', 'aptos development'],
      'func_developer': ['func', 'ton development', 'tvm'],
      'cosmwasm_developer': ['cosmwasm', 'rust', 'cosmos ecosystem'],
      'haskell_developer': ['haskell', 'cardano development', 'plutus'],
      'vyper_developer': ['vyper', 'ethereum development', 'gas optimization'],
      'frontend_developer': ['react', 'javascript', 'web3.js', 'UI/UX'],
      'backend_developer': ['node.js', 'express', 'database management', 'API development'],
      'game_developer': ['unity', 'c#', 'game design', 'blockchain integration'],
      // ... 其他角色 ...
    };
    
    return defaultSkills[role.toLowerCase()] || ['adaptability', 'continuous learning', 'blockchain fundamentals'];
  }

  getStandardTaskDecompositionTemplate(blockchainPlatform) {
    const commonTasks = [
      {
        agentType: "frontend_developer",
        requiredSkills: ["React", "Web3.js", "UI/UX"]
      },
      {
        agentType: "backend_developer",
        requiredSkills: ["Node.js", "API Development", "Database Management"]
      },
      {
        agentType: "game_developer",
        requiredSkills: ["Game Design", "Unity", "Blockchain Integration"]
      }
    ];

    const blockchainSpecificTask = {
      solana: {
        agentType: "rust_developer",
        requiredSkills: ["Rust", "Solana Program Development", "Anchor Framework"]
      },
      ethereum: {
        agentType: "solidity_developer",
        requiredSkills: ["Solidity", "Smart Contract Security", "Gas Optimization"]
      },
      // 添加其他区块链平台的特定任务
    };

    return [...commonTasks, blockchainSpecificTask[blockchainPlatform] || blockchainSpecificTask.ethereum];
  }

  isGameDesignMessage(message) {
    const gameDesignKeywords = [
      'game', 'design', 'feature', 'gameplay', 'mechanics', 'level', 'character', 'quest', 'nft',
      '游戏', '设计', '功能', '玩法', '机制', '关卡', '角色', '任务', '非同质化代币'
    ];
    return gameDesignKeywords.some(keyword => 
      message.toLowerCase().includes(keyword.toLowerCase()) ||
      message.includes(keyword)
    );
  }
  
  async generateCode(task, agentType, context, existingCode = "", blockchainPlatform,gameType) {
    console.log('agentType:',agentType)
    console.log('blockchainPlatform:',blockchainPlatform)
    // console.log('gameType:',gameType)
    const agent = context.find(c => c.role === 'system' && c.content.includes(agentType));
    const agentBlockchainExpertise = agent ? this.extractBlockchainExpertise(agent.content) : [];
    
    const contractLanguage = this.determineContractLanguage(task, agentBlockchainExpertise);
    const developmentLanguage = this.getDevelopmentLanguage(blockchainPlatform);
    console.log('developmentLanguage:', developmentLanguage)

    let prompt;
    if (gameType === 'fullChain') {
      prompt = PromptTemplate.fromTemplate(
        "You are a {agentType} specializing in {blockchainPlatform} development for full-chain games. " +
        "Generate or modify code based on the following task. All game logic should be implemented on-chain. " +
        "If existing code is provided, modify it. Otherwise, create new code.\n" +
        "Use {developmentLanguage} for smart contract development.\n" +
        "Task: {task}\n" +
        "Existing code:\n{existingCode}\n" +
        "Generated/Modified code:"
      );
    } else {
      prompt = PromptTemplate.fromTemplate(
        "You are a {agentType} specializing in {blockchainPlatform} development for semi on-chain games. " +
        "Generate or modify code based on the following task. Only core assets and critical game logic should be on-chain. " +
        "Other game logic should be implemented off-chain. " +
        "If existing code is provided, modify it. Otherwise, create new code.\n" +
        "Use {developmentLanguage} for smart contract development and appropriate off-chain languages for other parts.\n" +
        "Task: {task}\n" +
        "Existing code:\n{existingCode}\n" +
        "Generated/Modified code:"
      );
    }

    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ 
      agentType, 
      blockchainPlatform,
      task, 
      existingCode,
      developmentLanguage
    });

    return result.text;
  }

  async reviewCode(code) {
    const prompt = PromptTemplate.fromTemplate(
      "Review the following code and provide feedback " +
      "on its quality and potential improvements.\n" +
      "Code:\n{code}\n" +
      "Review:"
    );

    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ code });
    return result.text;
  }

  async applyCodeReview(code, review) {
    const prompt = PromptTemplate.fromTemplate(
      "Apply the following code review feedback to the given code:\n" +
      "Original code:\n{code}\n" +
      "Review feedback:\n{review}\n" +
      "Updated code:"
    );

    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ code, review });
    return this.formatResponse(result.text);
  }

  ensureCorrectCodeLanguage(code, language) {
    // 这个方法应该检查代码是否使用了正确的语言
    // 如果没有，它应该尝试将代码转换为正确的语言
    // 这里是一个简单的实现，实际上可能需要更复杂的逻辑
    if (language.toLowerCase() === 'solidity' && !code.includes('pragma solidity')) {
      return `// SPDX-License-Identifier: MIT\n;pragma solidity ^0.8.0;\n\n${code}`;
    }
    return code;
  }

  formatResponse(text) {
    const parts = text.split('###CODE###');
    let formattedResponse = '';

    parts.forEach((part, index) => {
      if (index % 2 === 0) {
        // 非代码部分
        formattedResponse += part.trim() + '\n\n';
      } else {
        // 代码部分
        const code = part.trim();
        formattedResponse += "```\n" + code + "\n```\n\n";
      }
    });

    return formattedResponse.trim();
  }

  async isSimpleRequest(message, context) {
    // 1. 检查消息长度
    const isShortMessage = message.split(' ').length < 15;

    // 2. 检查是否包含复杂请求的关键词
    const complexRequestKeywords = ['implement', 'create', 'develop', 'build', 'design', 'optimize', 'refactor', 'integrate'];
    const containsComplexKeyword = complexRequestKeywords.some(keyword => message.toLowerCase().includes(keyword));

    // 3. 检查最近的对话上下文
    const recentMessages = context.slice(-5);
    const hasRecentTaskDecomposition = recentMessages.some(msg => 
      typeof msg.content === 'string' && msg.content.includes('taskDecomposition')
    );
    const isFollowUpQuestion = recentMessages.some(msg => 
      typeof msg.content === 'string' && (
        msg.content.toLowerCase().includes('anything else') ||
        msg.content.toLowerCase().includes('follow-up') ||
        msg.content.toLowerCase().includes('more questions')
      )
    );

    // 4. 检查是否涉及代码修改或新功能
    const codeRelatedKeywords = ['code', 'function', 'method', 'class', 'variable', 'bug', 'error', 'fix'];
    const isCodeRelated = codeRelatedKeywords.some(keyword => message.toLowerCase().includes(keyword));
    const isNewFeatureRequest = message.toLowerCase().includes('new feature') || message.toLowerCase().includes('add functionality');

    // 5. 使用 OpenAI 进行文本复杂度分析
    const isSimpleByOpenAI = await OpenAIService.analyzeTextComplexity(message, context);

    // 结合所有因素做出决定
    const isSimple = (isShortMessage && !containsComplexKeyword && !isCodeRelated && !isNewFeatureRequest && isSimpleByOpenAI) ||
                     (isFollowUpQuestion && !isCodeRelated && !isNewFeatureRequest);

    // 如果最近有任务分解，倾向于认为是简单请求，除非明确是复杂请求
    if (hasRecentTaskDecomposition && !containsComplexKeyword && !isNewFeatureRequest) {
      return true;
    }

    return isSimple;
  }

  customJSONParse(str) {
    // 替换所有的 JavaScript 表达式
    str = str.replace(/:\s*([^,}\]]+)\s*([,}\]])/g, (match, expr, delimiter) => {
      // 如果表达式不是一个有效的 JSON 值，就将其转换为字符串
      if (!/^(true|false|null|\d+|".*")$/i.test(expr.trim())) {
        return `: "${expr.trim()}"${delimiter}`;
      }
      return match;
    });
  
    // 尝试解析修改后的字符串
    try {
      return JSON.parse(str);
    } catch (e) {
      console.error('Error parsing JSON:', e);
      console.error('Problematic JSON string:', str);
      throw e;
    }
  }
  
  async generateExpectedOutput(taskDescription, agentType) {
    const prompt = PromptTemplate.fromTemplate(`
      Given the following task description and agent type, generate an expected output.
      The expected output should be specific, measurable, and aligned with the task goals.
  
      Task Description: {taskDescription}
      Agent Type: {agentType}
  
      Expected Output: `);
  
    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ taskDescription, agentType });
    return result.text.trim();
  }
  
  async validateTaskOutput(output, expectedOutput) {
    const prompt = PromptTemplate.fromTemplate(`
      Compare the following task output with the expected output.
      Determine if the output meets the expectations.
  
      Task Output: {output}
      Expected Output: {expectedOutput}
  
      Does the output meet the expectations? Respond with 'Yes' or 'No' and provide a brief explanation.
    `);
  
    const chain = new LLMChain({ llm: this.llm, prompt });
    const result = await chain.call({ output, expectedOutput });
    const response = result.text.trim().toLowerCase();
    return response.startsWith('yes');
  }

  truncateExpectedOutput(output, maxLength = 100) {
    if (output.length <= maxLength) return output;
    return output.substring(0, maxLength - 3) + '...';
  }
  
  detectUserLanguage(message) {
    const chineseChars = (message.match(/[\u4e00-\u9fa5]/g) || []).length;
    return chineseChars > message.length / 4 ? '中文' : 'English';
  }

  async getAgentSkills(agentType) {
    const agentSkillsMap = {
      'solidity_developer': ['solidity', 'smart contracts', 'ethereum', 'web3.js', 'truffle', 'hardhat'],
      'frontend_developer': ['javascript', 'typescript', 'react', 'vue.js', 'angular', 'html', 'css', 'sass'],
      'backend_developer': ['python', 'node.js', 'java', 'c#', 'ruby', 'php', 'sql', 'nosql', 'rest api'],
      'full_stack_developer': ['javascript', 'python', 'react', 'node.js', 'sql', 'nosql', 'html', 'css', 'git'],
      'data_scientist': ['python', 'r', 'sql', 'machine learning', 'data analysis', 'statistics', 'pandas', 'numpy'],
      'devops_engineer': ['docker', 'kubernetes', 'jenkins', 'aws', 'azure', 'ci/cd', 'linux', 'shell scripting'],
      'mobile_developer': ['swift', 'kotlin', 'java', 'react native', 'flutter', 'ios', 'android'],
      'game_developer': ['c++', 'c#', 'unity', 'unreal engine', 'opengl', 'directx', 'game design'],
      'security_expert': ['penetration testing', 'cryptography', 'network security', 'ethical hacking', 'security audits'],
      'blockchain_developer': ['solidity', 'ethereum', 'hyperledger', 'cryptocurrencies', 'smart contracts', 'consensus algorithms'],
      'ai_engineer': ['python', 'tensorflow', 'pytorch', 'natural language processing', 'computer vision', 'deep learning'],
      'ux_designer': ['user research', 'wireframing', 'prototyping', 'usability testing', 'figma', 'sketch'],
      'qa_engineer': ['test automation', 'selenium', 'junit', 'test planning', 'bug tracking', 'performance testing'],
      'database_administrator': ['sql', 'mysql', 'postgresql', 'oracle', 'mongodb', 'database optimization', 'data modeling'],
      'network_engineer': ['cisco', 'routing protocols', 'network security', 'vpn', 'subnetting', 'firewall configuration'],
      'embedded_systems_engineer': ['c', 'c++', 'assembly', 'rtos', 'microcontrollers', 'iot'],
      'cloud_architect': ['aws', 'azure', 'google cloud', 'cloud migration', 'serverless architecture', 'iaas', 'paas'],
      'ar_vr_developer': ['unity', 'unreal engine', '3d modeling', 'computer vision', 'spatial computing', 'webxr'],
      'data_engineer': ['apache spark', 'hadoop', 'etl', 'data warehousing', 'big data technologies', 'data pipelines'],
      'systems_analyst': ['business analysis', 'requirements gathering', 'process modeling', 'uml', 'system architecture'],
      'technical_writer': ['documentation', 'api documentation', 'technical communication', 'markdown', 'content management systems'],
      'product_manager': ['agile methodologies', 'product roadmapping', 'user stories', 'market analysis', 'stakeholder management']
    };
    return agentSkillsMap[agentType] || [];
  }
  
  getLanguageForAgentType(agentType) {
    const agentTypeLanguageMap = {
      'solidity_developer': 'solidity',
      'frontend_developer': 'javascript',
      'backend_developer': 'python',
      'full_stack_developer': 'javascript',
      'data_scientist': 'python',
      'devops_engineer': 'bash',
      'mobile_developer': 'swift',
      'game_developer': 'c++',
      'security_expert': 'python',
      'blockchain_developer': 'solidity',
      'ai_engineer': 'python',
      'ux_designer': 'javascript',
      'qa_engineer': 'python',
      'database_administrator': 'sql',
      'network_engineer': 'python',
      'embedded_systems_engineer': 'c',
      'cloud_architect': 'yaml',
      'ar_vr_developer': 'c#',
      'data_engineer': 'python',
      'systems_analyst': 'uml',
      'technical_writer': 'markdown',
      'product_manager': 'markdown'
    };
    return agentTypeLanguageMap[agentType] || 'javascript';
  }

  getPreferredLanguage(skills) {
    const languageMap = {
      'solidity': 'solidity',
      'smart contracts': 'solidity',
      'javascript': 'javascript',
      'react': 'javascript',
      'python': 'python',
      'node.js': 'javascript',
      // ... 其他技能到语言的映射
    };
    return skills.map(skill => languageMap[skill]).find(lang => lang) || null;
  }

  getLanguageFromContext(context) {
    // 简单实现：检查上下文中最后一条消息是否包含代码块，并推断语言
    const lastMessage = context[context.length - 1];
    if (lastMessage && lastMessage.content) {
      const codeBlockMatch = lastMessage.content.match(/```(\w+)/);
      if (codeBlockMatch) {
        return codeBlockMatch[1].toLowerCase();
      }
    }
    return null;
  }
  
  validateBlockchainCode(response, blockchain_expertise) {
    const codeBlocks = response.match(/```[\s\S]*?```/g);
    if (codeBlocks) {
      blockchain_expertise.forEach(expertise => {
        const keywords = this.getBlockchainKeywords(expertise);
        codeBlocks.forEach((block, index) => {
          const code = block.replace(/```\w*\n|```/g, '');
          if (!keywords.some(keyword => code.includes(keyword))) {
            codeBlocks[index] = `\`\`\`\n// The generated code may not be valid for ${expertise}.\n// Please review and adjust as necessary.\n${code}\n\`\`\``;
          }
        });
      });
      response = response.replace(/```[\s\S]*?```/g, () => codeBlocks.shift());
    }
    return response;
  }
  
  determineContractLanguage(task, expertise) {
    const taskLower = task.toLowerCase();
    const expertiseLower = expertise.map(e => e.toLowerCase());

    if (taskLower.includes('solana') || expertiseLower.includes('solana')) {
      return 'rust';
    } else if (taskLower.includes('ton') || expertiseLower.includes('ton')) {
      return 'func';
    } else if (taskLower.includes('sui') || taskLower.includes('aptos') || expertiseLower.includes('move')) {
      return 'move';
    } else if (taskLower.includes('cosmos') || expertiseLower.includes('cosmwasm')) {
      return 'cosmwasm (rust)';
    } else if (taskLower.includes('cardano') || expertiseLower.includes('cardano')) {
      return 'haskell (plutus)';
    } else {
      return 'solidity'; // 默认为Solidity
    }
  }

  extractBlockchainExpertise(content) {
    const blockchainKeywords = ['ethereum', 'solana', 'ton', 'sui', 'aptos', 'cosmos', 'cardano'];
    return blockchainKeywords.filter(keyword => content.toLowerCase().includes(keyword));
  }

  detectBlockchainPlatform(message, context) {
    const combinedText = message.toLowerCase() + ' ' + context.map(c => c.content?.toLowerCase() || '').join(' ');
    if (combinedText.includes('solana')) return 'solana';
    if (combinedText.includes('ethereum')) return 'ethereum';
    if (combinedText.includes('ton')) return 'ton';
    return 'ethereum'; // 默认
  }

  adjustAgentTypeForPlatform(agentType, platform) {
    // const platformAgentMap = {
    //   'solana': { 'smartcontract_developer': 'rust_developer', 'blockchain_developer': 'rust_developer' },
    //   'ethereum': { 'smartcontract_developer': 'solidity_developer', 'blockchain_developer': 'solidity_developer' },
    //   // 添加其他平台的映射
    // };

    // return platformAgentMap[platform]?.[agentType] || agentType;
    if (platform === 'solana' && agentType === 'solidity_developer') {
      return 'rust_developer'
    }
    if (platform === 'aptos' && agentType === 'solidity_developer') {
      return 'move_developer'
    }
    if (platform === 'ton' && agentType === 'solidity_developer') {
      return 'func_developer'
    }
    return agentType
  }

  adjustSkillsForPlatform(skills, platform) {
    const platformSkills = {
      'solana': ['rust', 'anchor', 'solana program development'],
      'ethereum': ['solidity', 'web3.js', 'ethereum development'],
      // 添加其他平台的技能
    };

    if (skills.includes('smart contract development') || skills.includes('blockchain development')) {
      return [...new Set([...skills, ...(platformSkills[platform] || platformSkills.ethereum)])];
    }
    return skills;
  }

  async generateSolanaCode(taskDescription) {
    return `
        // Solana Program
        use anchor_lang::prelude::*;

        declare_id!("YourProgramID");

        #[program]
        pub mod your_program_name {
            use super::*;
            pub fn initialize(ctx: Context<Initialize>) -> ProgramResult {
                // 初始化逻辑
                Ok(())
            }
        }

        #[derive(Accounts)]
        pub struct Initialize<'info> {
            #[account(init, payer = user, space = 8 + 64)]
            pub my_account: Account<'info, MyAccount>,
            #[account(mut)]
            pub user: Signer<'info>,
            pub system_program: Program<'info, System>,
        }

        #[account]
        pub struct MyAccount {
            pub data: String,
        }
    `;
  }

  async generateSolidityCode(taskDescription) {
    return `
        // SPDX-License-Identifier: MIT
        pragma solidity ^0.8.0;

        contract YourContractName {
            string public data;

            constructor(string memory initialData) {
                data = initialData;
            }

            function setData(string memory newData) public {
                data = newData;
            }

            function getData() public view returns (string memory) {
                return data;
            }
        }
    `;
  }

  async generateTonCode(taskDescription) {
    return `
        // TON Smart Contract
        pragma ton-solidity >= 0.47.0;

        contract YourTonContract {
            string public data;

            constructor(string memory initialData) {
                data = initialData;
            }

            public function setData(string memory newData) {
                data = newData;
            }

            public function getData() public view returns (string memory) {
                return data;
            }
        }
    `;
  }

  detectGameType(message) {
    const fullChainKeywords = ['全链', '完全去中心化', 'fully decentralized', 'on-chain', 'onchain', 'full chain'];
    const lowerMessage = message.toLowerCase();
  
    if (fullChainKeywords.some(keyword => lowerMessage.includes(keyword))) {
      return 'fullChain';
    } else {
      return 'halfChain'; // 默认为半全链游戏
    }
  }
  
  getDevelopmentLanguage(blockchainPlatform) {
    const languageMap = {
      'ethereum': 'Solidity',
      'solana': 'Rust',
      'aptos': 'Move',
      'sui': 'Move',
      'ton': 'FunC',
      'cosmos': 'CosmWasm (Rust)',
      'cardano': 'Plutus (Haskell)',
      // Add more blockchain platforms and their corresponding languages as needed
    };
    return languageMap[blockchainPlatform.toLowerCase()] || 'Unknown';
  }

  async getRelevantCode(context, conversationState) {
    if (conversationState.lastDiscussedCode) {
      return conversationState.lastDiscussedCode;
    }
    return this.extractExistingCode(context);
  }

}

module.exports = new LangChainService();
