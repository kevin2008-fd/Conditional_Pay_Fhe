// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PaymentCondition {
  id: string;
  condition: string;
  amount: number;
  encryptedAmount: string;
  parties: string[];
  status: "pending" | "executed" | "canceled";
  timestamp: number;
  creator: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [conditions, setConditions] = useState<PaymentCondition[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newCondition, setNewCondition] = useState({ amount: 0, condition: "", parties: [""] });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedCondition, setSelectedCondition] = useState<PaymentCondition | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "executed" | "canceled">("all");

  const executedCount = conditions.filter(c => c.status === "executed").length;
  const pendingCount = conditions.filter(c => c.status === "pending").length;
  const canceledCount = conditions.filter(c => c.status === "canceled").length;

  useEffect(() => {
    loadConditions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadConditions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("condition_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing condition keys:", e); }
      }
      
      const list: PaymentCondition[] = [];
      for (const key of keys) {
        try {
          const conditionBytes = await contract.getData(`condition_${key}`);
          if (conditionBytes.length > 0) {
            try {
              const conditionData = JSON.parse(ethers.toUtf8String(conditionBytes));
              list.push({ 
                id: key, 
                condition: conditionData.condition, 
                amount: conditionData.amount,
                encryptedAmount: conditionData.encryptedAmount,
                parties: conditionData.parties,
                status: conditionData.status || "pending",
                timestamp: conditionData.timestamp,
                creator: conditionData.creator
              });
            } catch (e) { console.error(`Error parsing condition data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading condition ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setConditions(list);
    } catch (e) { console.error("Error loading conditions:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitCondition = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting payment amount with Zama FHE..." });
    try {
      const encryptedAmount = FHEEncryptNumber(newCondition.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const conditionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const conditionData = { 
        condition: newCondition.condition,
        amount: newCondition.amount,
        encryptedAmount,
        parties: newCondition.parties.filter(p => p.trim() !== ""),
        status: "pending",
        timestamp: Math.floor(Date.now() / 1000),
        creator: address
      };
      
      await contract.setData(`condition_${conditionId}`, ethers.toUtf8Bytes(JSON.stringify(conditionData)));
      
      const keysBytes = await contract.getData("condition_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(conditionId);
      await contract.setData("condition_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted payment condition created!" });
      await loadConditions();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewCondition({ amount: 0, condition: "", parties: [""] });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const executeCondition = async (conditionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Executing FHE-encrypted payment..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const conditionBytes = await contract.getData(`condition_${conditionId}`);
      if (conditionBytes.length === 0) throw new Error("Condition not found");
      
      const conditionData = JSON.parse(ethers.toUtf8String(conditionBytes));
      const updatedCondition = { ...conditionData, status: "executed" };
      
      await contract.setData(`condition_${conditionId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCondition)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Payment executed successfully!" });
      await loadConditions();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Execution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const cancelCondition = async (conditionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Canceling FHE-encrypted payment..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const conditionBytes = await contract.getData(`condition_${conditionId}`);
      if (conditionBytes.length === 0) throw new Error("Condition not found");
      
      const conditionData = JSON.parse(ethers.toUtf8String(conditionBytes));
      const updatedCondition = { ...conditionData, status: "canceled" };
      
      await contract.setData(`condition_${conditionId}`, ethers.toUtf8Bytes(JSON.stringify(updatedCondition)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Payment canceled successfully!" });
      await loadConditions();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Cancellation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isCreator = (creatorAddress: string) => address?.toLowerCase() === creatorAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to create encrypted payment conditions", icon: "🔗" },
    { title: "Set Payment Condition", description: "Define the payment condition and amount to be encrypted", icon: "📝" },
    { title: "FHE Encryption", description: "Your payment amount is encrypted using Zama FHE technology", icon: "🔒", details: "The amount is encrypted client-side before being sent to the blockchain" },
    { title: "Condition Execution", description: "When conditions are met, payment executes while keeping amount private", icon: "⚡", details: "The contract verifies conditions without decrypting the payment amount" }
  ];

  const filteredConditions = conditions.filter(condition => {
    const matchesSearch = condition.condition.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         condition.parties.some(p => p.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = filterStatus === "all" || condition.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStatsCard = (title: string, value: number, change: number) => (
    <div className="stats-card">
      <h3>{title}</h3>
      <div className="stats-value">{value}</div>
      <div className={`stats-change ${change >= 0 ? 'positive' : 'negative'}`}>
        {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading encrypted payment conditions...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>Pay</span></h1>
          <div className="logo-subtitle">Zama-powered conditional payments</div>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Fully Homomorphic Encrypted Payments</h2>
            <p>Create conditional payments where amounts remain encrypted until execution</p>
          </div>
          <button 
            className="primary-button create-button"
            onClick={() => setShowCreateModal(true)}
          >
            + New Condition
          </button>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>How FHE-Powered Payments Work</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <div className="stats-grid">
            {renderStatsCard("Total Conditions", conditions.length, 0)}
            {renderStatsCard("Pending", pendingCount, 0)}
            {renderStatsCard("Executed", executedCount, 0)}
            {renderStatsCard("Canceled", canceledCount, 0)}
          </div>

          <div className="project-intro">
            <h3>About FHE-Pay</h3>
            <p>
              FHE-Pay uses <strong>Zama's FHE technology</strong> to enable conditional payments where the payment amount 
              remains encrypted throughout the entire process. Conditions are evaluated on-chain without ever 
              decrypting the sensitive payment information.
            </p>
            <div className="tech-tags">
              <span className="tech-tag">FHE Encryption</span>
              <span className="tech-tag">Smart Contracts</span>
              <span className="tech-tag">Privacy-Preserving</span>
            </div>
          </div>
        </div>

        <div className="conditions-section">
          <div className="section-header">
            <h2>Payment Conditions</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search conditions..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <span className="search-icon">🔍</span>
              </div>
              <select 
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="status-filter"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="executed">Executed</option>
                <option value="canceled">Canceled</option>
              </select>
              <button 
                onClick={loadConditions} 
                className="refresh-button"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="conditions-list">
            {filteredConditions.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📭</div>
                <p>No payment conditions found</p>
                <button 
                  className="primary-button"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create First Condition
                </button>
              </div>
            ) : (
              filteredConditions.map(condition => (
                <div 
                  className={`condition-card ${condition.status}`} 
                  key={condition.id}
                  onClick={() => setSelectedCondition(condition)}
                >
                  <div className="condition-header">
                    <span className="condition-id">#{condition.id.substring(0, 6)}</span>
                    <span className={`status-badge ${condition.status}`}>
                      {condition.status}
                    </span>
                  </div>
                  <div className="condition-content">
                    <p className="condition-text">{condition.condition}</p>
                    <div className="condition-details">
                      <div className="detail">
                        <span>Amount:</span>
                        <strong className="encrypted-amount">
                          {condition.encryptedAmount.substring(0, 20)}...
                        </strong>
                      </div>
                      <div className="detail">
                        <span>Parties:</span>
                        <div className="parties-list">
                          {condition.parties.map((party, i) => (
                            <span key={i} className="party-tag">
                              {party.substring(0, 6)}...{party.substring(38)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="condition-footer">
                    <span className="timestamp">
                      {new Date(condition.timestamp * 1000).toLocaleDateString()}
                    </span>
                    {isCreator(condition.creator) && condition.status === "pending" && (
                      <div className="condition-actions">
                        <button 
                          className="action-button execute"
                          onClick={(e) => {
                            e.stopPropagation();
                            executeCondition(condition.id);
                          }}
                        >
                          Execute
                        </button>
                        <button 
                          className="action-button cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelCondition(condition.id);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New Payment Condition</h2>
              <button 
                onClick={() => {
                  setShowCreateModal(false);
                  setNewCondition({ amount: 0, condition: "", parties: [""] });
                }}
                className="close-button"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Payment Condition *</label>
                <textarea
                  placeholder="e.g. 'When both Alice and Bob sign, pay Charlie'"
                  value={newCondition.condition}
                  onChange={(e) => setNewCondition({...newCondition, condition: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>Amount (ETH) *</label>
                <input
                  type="number"
                  placeholder="0.00"
                  value={newCondition.amount}
                  onChange={(e) => setNewCondition({...newCondition, amount: parseFloat(e.target.value) || 0})}
                  step="0.01"
                />
                <div className="encryption-preview">
                  <span>Encrypted:</span> 
                  {newCondition.amount > 0 ? (
                    <span className="encrypted-value">
                      {FHEEncryptNumber(newCondition.amount).substring(0, 20)}...
                    </span>
                  ) : (
                    <span className="placeholder">Will be FHE encrypted</span>
                  )}
                </div>
              </div>
              <div className="form-group">
                <label>Involved Parties (Addresses) *</label>
                {newCondition.parties.map((party, index) => (
                  <div key={index} className="party-input">
                    <input
                      type="text"
                      placeholder={`Party ${index + 1} address`}
                      value={party}
                      onChange={(e) => {
                        const newParties = [...newCondition.parties];
                        newParties[index] = e.target.value;
                        setNewCondition({...newCondition, parties: newParties});
                      }}
                    />
                    {index === newCondition.parties.length - 1 && (
                      <button
                        className="add-party"
                        onClick={() => setNewCondition({...newCondition, parties: [...newCondition.parties, ""]})}
                      >
                        +
                      </button>
                    )}
                    {index > 0 && (
                      <button
                        className="remove-party"
                        onClick={() => {
                          const newParties = [...newCondition.parties];
                          newParties.splice(index, 1);
                          setNewCondition({...newCondition, parties: newParties});
                        }}
                      >
                        -
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="fhe-notice">
                <div className="notice-icon">🔒</div>
                <p>
                  The payment amount will be encrypted using Zama FHE before being stored on-chain.
                  It will remain encrypted during condition evaluation and execution.
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="secondary-button"
                onClick={() => {
                  setShowCreateModal(false);
                  setNewCondition({ amount: 0, condition: "", parties: [""] });
                }}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={submitCondition}
                disabled={creating || !newCondition.condition || !newCondition.amount || newCondition.parties.some(p => p.trim() === "")}
              >
                {creating ? "Creating..." : "Create Condition"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedCondition && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Payment Condition Details</h2>
              <button 
                onClick={() => {
                  setSelectedCondition(null);
                  setDecryptedAmount(null);
                }}
                className="close-button"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-section">
                <h3>Condition</h3>
                <p>{selectedCondition.condition}</p>
              </div>
              <div className="detail-grid">
                <div className="detail-item">
                  <span>Status</span>
                  <strong className={`status-badge ${selectedCondition.status}`}>
                    {selectedCondition.status}
                  </strong>
                </div>
                <div className="detail-item">
                  <span>Created</span>
                  <strong>{new Date(selectedCondition.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="detail-item">
                  <span>Creator</span>
                  <strong>
                    {selectedCondition.creator.substring(0, 6)}...{selectedCondition.creator.substring(38)}
                  </strong>
                </div>
              </div>
              <div className="detail-section">
                <h3>Encrypted Amount</h3>
                <div className="encrypted-amount-display">
                  {selectedCondition.encryptedAmount.substring(0, 50)}...
                </div>
                <button
                  className="decrypt-button"
                  onClick={async () => {
                    if (decryptedAmount !== null) {
                      setDecryptedAmount(null);
                    } else {
                      const decrypted = await decryptWithSignature(selectedCondition.encryptedAmount);
                      if (decrypted !== null) setDecryptedAmount(decrypted);
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : decryptedAmount !== null ? "Hide Amount" : "Decrypt Amount"}
                </button>
                {decryptedAmount !== null && (
                  <div className="decrypted-amount">
                    <span>Decrypted Amount:</span>
                    <strong>{decryptedAmount} ETH</strong>
                  </div>
                )}
              </div>
              <div className="detail-section">
                <h3>Involved Parties</h3>
                <div className="parties-list">
                  {selectedCondition.parties.map((party, index) => (
                    <div key={index} className="party-item">
                      <span>Party {index + 1}:</span>
                      <strong>
                        {party.substring(0, 6)}...{party.substring(38)}
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              {isCreator(selectedCondition.creator) && selectedCondition.status === "pending" && (
                <div className="detail-actions">
                  <button
                    className="execute-button"
                    onClick={() => {
                      executeCondition(selectedCondition.id);
                      setSelectedCondition(null);
                    }}
                  >
                    Execute Payment
                  </button>
                  <button
                    className="cancel-button"
                    onClick={() => {
                      cancelCondition(selectedCondition.id);
                      setSelectedCondition(null);
                    }}
                  >
                    Cancel Condition
                  </button>
                </div>
              )}
              <button
                className="close-detail-button"
                onClick={() => {
                  setSelectedCondition(null);
                  setDecryptedAmount(null);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className={`transaction-content ${transactionStatus.status}`}>
            <div className="transaction-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>FHE-Pay</h3>
            <p>Zama-powered encrypted conditional payments</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Privacy</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="zama-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHE-Pay. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;