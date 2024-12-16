const OpenAI = require("openai");

class OpenAIService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async createChatCompletion(messages, model = "gpt-4o-mini", maxTokens = 1500) {
    try {

      // 确保messages是数组
      if (!Array.isArray(messages)) {
        messages = [{ role: 'user', content: String(messages) }];
      }

      // 格式化和验证所有消息
      const formattedMessages = messages.map(msg => {
        // 如果消息是字符串，转换为对象格式
        if (typeof msg === 'string') {
          return { role: 'user', content: msg };
        }

        // 如果已经是正确格式，验证并返回
        if (msg && typeof msg === 'object' && msg.role && typeof msg.content === 'string') {
          return {
            role: msg.role,
            content: msg.content
          };
        }

        // 如果消息有sender属性
        if (msg && typeof msg === 'object' && msg.sender) {
          return {
            role: this.mapSenderToRole(msg.sender),
            content: String(msg.content || '')
          };
        }

        // 默认情况
        return {
          role: 'user',
          content: String(msg?.content || msg || '')
        };
      });

      // 过滤掉无效消息
      const validMessages = formattedMessages.filter(msg => 
        msg.content && msg.content.trim() !== '' &&
        ['user', 'system', 'assistant'].includes(msg.role)
      );

      // 确保至少有一条有效消息
      if (validMessages.length === 0) {
        throw new Error('No valid messages to process');
      }

      const completion = await this.openai.chat.completions.create({
        model: model,
        messages: validMessages,
        max_tokens: maxTokens
      });

      this.retryCount = 0;
      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error in createChatCompletion:', error);
      
      if (error.status === 429) {
        return await this.handleRateLimitError(messages, model, maxTokens);
      }

      if (error.status === 400) {
        const fallbackMessage = this.createFallbackMessage(messages);
        return await this.handleBadRequestError(fallbackMessage);
      }

      return await this.handleGeneralError(messages);
    }
  }

  async analyzeTextComplexity(message, context) {
    try {
      const completion = await this.createChatCompletion([
        { role: "system", content: "You are an AI assistant tasked with analyzing the complexity of user requests." },
        { role: "user", content: `Analyze the following message and determine if it requires a simple response or a complex task decomposition. Consider the context of the conversation and the nature of the request. Respond with "Simple" if it's a straightforward question or request that doesn't require extensive processing or task breakdown. Respond with "Complex" if it involves multiple steps, requires significant changes, or needs a detailed explanation or implementation.

        Context: ${context.map(msg => `${msg.sender}: ${msg.content}`).join('\n')}
        
        Message: ${message}
        
        Classification (Simple/Complex):` }
      ], "gpt-4o-mini", 1);

      return completion.toLowerCase().includes('simple');
    } catch (error) {
      console.error('Error analyzing text complexity:', error);
      // 如果 API 调用失败，我们默认认为是复杂请求
      return false;
    }
  }

  async summarizeContent(content) {
    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an AI assistant tasked with summarizing web content. Provide a concise summary of the main points and key information." },
          { role: "user", content: `Please summarize the following content:\n\n${content}` }
        ],
        max_tokens: 500
      });

      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error in summarizeContent:', error);
      throw error;
    }
  }

  mapSenderToRole(sender) {
    const roleMap = {
      'user': 'user',
      'system': 'system',
      'agent': 'assistant',
      'assistant': 'assistant'
    };
    return roleMap[sender.toLowerCase()] || 'user';
  }

  createFallbackMessage(messages) {
    // 提取最后一条用户消息
    let userMessage = '';
    let systemMessage = '';

    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg === 'string') {
          userMessage = msg;
          continue;
        }
        
        const role = msg.role || msg.sender;
        const content = msg.content || '';

        if (role === 'system' || role === 'system') {
          systemMessage = content;
        } else if (role === 'user' || !systemMessage) {
          userMessage = content;
        }
      }
    } else {
      userMessage = String(messages || '');
    }

    return [
      { role: 'system', content: systemMessage || 'You are a helpful assistant.' },
      { role: 'user', content: userMessage }
    ];
  }

  async handleBadRequestError(messages) {
    try {
      // 使用最基本的消息格式重试
      const fallbackMessages = this.createFallbackMessage(messages);
      
      console.log('Fallback messages:', JSON.stringify(fallbackMessages, null, 2));

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: fallbackMessages,
        max_tokens: 1500
      });

      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error in handleBadRequestError:', error);
      return "I apologize, but I encountered an error processing your request.";
    }
  }

  async handleGeneralError(messages) {
    try {
      // 增加重试计数
      this.retryCount++;

      // 如果未超过最大重试次数,进行重试
      if (this.retryCount < this.maxRetries) {
        // 使用指数退避策略计算延迟时间
        const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);
        console.log(`Retrying request (attempt ${this.retryCount}) after ${delay}ms delay...`);
        
        // 等待延迟时间
        await new Promise(resolve => setTimeout(resolve, delay));

        // 使用更简单的消息格式重试
        const simplifiedMessages = this.createFallbackMessage(messages);
        
        // 使用较低的token限制重试
        const completion = await this.openai.chat.completions.create({
          model: "gpt-3.5-turbo", // 降级到更稳定的模型
          messages: simplifiedMessages,
          max_tokens: 1000, // 降低token限制
          temperature: 0.7
        });

        return completion.choices[0].message.content.trim();
      }

      // 超过最大重试次数,返回友好的错误消息
      console.error(`Failed after ${this.maxRetries} retries. Original error:`, messages);
      
      // 根据消息内容生成合适的降级响应
      let fallbackResponse = "I apologize, but I'm having trouble processing your request. ";
      
      // 分析原始消息类型,提供相应的建议
      if (typeof messages[messages.length - 1]?.content === 'string') {
        const lastMessage = messages[messages.length - 1].content.toLowerCase();
        
        if (lastMessage.includes('code') || lastMessage.includes('program')) {
          fallbackResponse += "Please try simplifying your code request or breaking it into smaller parts.";
        } else if (lastMessage.includes('explain') || lastMessage.includes('how')) {
          fallbackResponse += "Please rephrase your question in a simpler way.";
        } else {
          fallbackResponse += "Please try again with a shorter or simpler request.";
        }
      } else {
        fallbackResponse += "Please try again in a moment.";
      }

      return fallbackResponse;

    } catch (error) {
      // 处理重试过程中的错误
      console.error('Error in handleGeneralError:', error);
      return "I'm currently experiencing technical difficulties. Please try again later.";
    } finally {
      // 重置重试计数器
      this.retryCount = 0;
    }
  }

}

module.exports = new OpenAIService();
