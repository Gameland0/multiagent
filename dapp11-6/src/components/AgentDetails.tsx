import React, { useState, useEffect, useContext } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Web3Context } from '../contexts/Web3Context';
import { AgentRegistry } from '../contracts/AgentRegistry';
import AgentTraining from './AgentTraining';
import {
  getAgentDetails,
  updateAgent,
  getAgentKnowledge,
  deleteAgent,
  toggleAgentPublicity
} from '../services/api';
import Web3 from 'web3';

interface Agent {
  id: number;
  name: string;
  description: string;
  type: string;
  is_public: boolean;
  owner: string;
  imageUrl?: string;
  model?: string; // 新增字段
  trainingData?: {
    ipfsHash: string;
    trained_at: string;
    userAddress: string;
  }[];
}

interface Knowledge {
  key_phrase: string;
  content: string;
}

const AgentDetails: React.FC = () => {
  const web3Instance = new Web3((window as any).ethereum)
  const { agentId } = useParams<{ agentId: string }>();
  const { account, web3 } = useContext(Web3Context);
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [trainingData, setTrainingData] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedAgent, setEditedAgent] = useState<Partial<Agent>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [showTraining, setShowTraining] = useState(false);

  useEffect(() => {
    fetchAgentDetails();
    fetchAgentKnowledge();
  }, [agentId]);

  const fetchAgentDetails = async () => {
    if (agentId) {
      try {
        const details = await getAgentDetails(Number(agentId));
        setAgent(details);
        setEditedAgent(details);
      } catch (error) {
        console.error('Error fetching agent details:', error);
      }
    }
  };

  const fetchAgentKnowledge = async () => {
    if (agentId) {
      try {
        const knowledgeData = await getAgentKnowledge(Number(agentId));
        setKnowledge(knowledgeData);
      } catch (error) {
        console.error('Error fetching agent knowledge:', error);
      }
    }
  };

  const handleTogglePublicity = async () => {
    if (!agent) return;
    try {
      const agentRegistry = new AgentRegistry(web3Instance!);
      await agentRegistry.toggleAgentPublicity(agent.id, account!);
      await toggleAgentPublicity(agent.id);
      fetchAgentDetails();
    } catch (error) {
      console.error('Error toggling agent publicity:', error);
      alert('Failed to toggle agent publicity. Please try again.');
    }
  };

  const handleUpdateAgent = async () => {
    if (!agent) return;
    try {
      await updateAgent(agent.id, editedAgent);
      setIsEditing(false);
      fetchAgentDetails();
      alert('Agent updated successfully!');
    } catch (error) {
      console.error('Error updating agent:', error);
      alert('Failed to update agent. Please try again.');
    }
  };

  const handleDeleteAgent = async () => {
    if (!agent) return;
    if (window.confirm('Are you sure you want to delete this agent?')) {
      try {
        await deleteAgent(agent.id);
        alert('Agent deleted successfully!');
        navigate('/chat');
      } catch (error) {
        console.error('Error deleting agent:', error);
        alert('Failed to delete agent. Please try again.');
      }
    }
  };

  if (!agent) {
    return <div>Loading...</div>;
  }

  return (
    <div className="agent-details">
      <Link to="/chat" className="back-button">Back to Chat</Link>
      {isEditing ? (
        <div>
          <input
            value={editedAgent.name || ''}
            onChange={(e) => setEditedAgent({ ...editedAgent, name: e.target.value })}
            placeholder="Agent Name"
          />
          <textarea
            value={editedAgent.description || ''}
            onChange={(e) => setEditedAgent({ ...editedAgent, description: e.target.value })}
            placeholder="Agent Description"
          />
          <input
            value={editedAgent.type || ''}
            onChange={(e) => setEditedAgent({ ...editedAgent, type: e.target.value })}
            placeholder="Agent Type"
          />
          <select
            value={editedAgent.model || ''}
            onChange={(e) => setEditedAgent({ ...editedAgent, model: e.target.value })}
          >
            <option value="">Select Model</option>
            <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            <option value="gpt-4">GPT-4</option>
            <option value="gpt-4o">GPT-4o</option>
            <option value="gpt-4o-mini">GPT-4o Mini</option>
            <option value="gemini-1.5-pro-001">gemini-1.5-pro-001</option>
            <option value="gemini-1.5-pro-002">gemini-1.5-pro-002</option>
            <option value="gemini-1.5-flash-001">gemini-1.5-flash-001</option>
            <option value="gemini-1.5-flash-002">gemini-1.5-flash-002</option>
          </select>
          <button onClick={handleUpdateAgent}>Save Changes</button>
          <button onClick={() => setIsEditing(false)}>Cancel</button>
        </div>
      )  : (
        <div className="agent-info">
          <h2>{agent.name}</h2>
          <p><strong>Description:</strong> {agent.description}</p>
          <p><strong>Type:</strong> {agent.type}</p>
          <p><strong>Public:</strong> {agent.is_public ? 'Yes' : 'No'}</p>
          <p><strong>Model:</strong> {agent.model || 'Default'}</p>
          {agent.imageUrl && <img src={agent.imageUrl} alt={agent.name} className="agent-image" />}
          {agent.owner === account && (
            <div className="button-group">
              <button onClick={() => setIsEditing(true)} className="edit-button">Edit Agent</button>
              <button onClick={handleTogglePublicity} className="toggle-button">
                {agent.is_public ? 'Make Private' : 'Make Public'}
              </button>
              <button onClick={handleDeleteAgent} className="delete-button">Delete Agent</button>
            </div>
          )}
        </div>
      )}
      <button onClick={() => setShowTraining(!showTraining)}>
        {showTraining ? 'Hide Training' : 'Train Agent'}
      </button>
      {showTraining && (
        <AgentTraining
          agentId={Number(agentId)}
          onTrainingComplete={() => {
            setShowTraining(false);
            fetchAgentDetails();
          }}
        />
      )}
      <h3>Training History</h3>
      {agent.trainingData && agent.trainingData.map((data, index) => (
        <div key={index} className="training-data-item">
          <p>IPFS Hash: {data.ipfsHash}</p>
          <p>Timestamp: {data.trained_at}</p>
          <p>Trainer: {data.userAddress}</p>
        </div>
      ))}
    </div>
  );

};

export default AgentDetails;

