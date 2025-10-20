pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ConditionalPayFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct PaymentCondition {
        euint32 amountA;
        euint32 amountB;
        euint32 totalAmount;
        ebool conditionMet;
    }
    mapping(uint256 => PaymentCondition) public paymentConditions; // batchId -> PaymentCondition

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event ConditionSubmitted(address indexed provider, uint256 batchId);
    event DecryptionRequested(uint256 requestId, uint256 batchId);
    event DecryptionCompleted(uint256 requestId, uint256 batchId, uint256 totalAmount, bool conditionMet);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidParameter();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;
        _;
    }

    modifier respectDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidParameter();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) revert InvalidParameter();
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused == paused) revert InvalidParameter();
        paused = _paused;
        if (_paused) {
            emit Paused(msg.sender);
        } else {
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        if (newCooldown == cooldownSeconds) revert InvalidParameter();
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldown);
        cooldownSeconds = newCooldown;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId || batchClosed[batchId]) revert InvalidParameter();
        batchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitCondition(
        euint32 _amountA,
        euint32 _amountB,
        euint32 _totalAmount
    ) external onlyProvider whenNotPaused respectCooldown {
        if (currentBatchId == 0 || batchClosed[currentBatchId]) revert BatchClosedOrInvalid();

        if (!_amountA.isInitialized()) revert NotInitialized();
        if (!_amountB.isInitialized()) revert NotInitialized();
        if (!_totalAmount.isInitialized()) revert NotInitialized();

        PaymentCondition storage pc = paymentConditions[currentBatchId];
        pc.amountA = _amountA;
        pc.amountB = _amountB;
        pc.totalAmount = _totalAmount;

        // FHE.add(_amountA, _amountB) == _totalAmount
        // This means (amountA + amountB) >= totalAmount AND (amountA + amountB) <= totalAmount
        euint32 sumAB = _amountA.add(_amountB);
        ebool sumAB_ge_total = sumAB.ge(_totalAmount);
        ebool sumAB_le_total = sumAB.le(_totalAmount);
        pc.conditionMet = sumAB_ge_total.and(sumAB_le_total);

        emit ConditionSubmitted(msg.sender, currentBatchId);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused respectDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId || !batchClosed[batchId]) revert BatchClosedOrInvalid();

        PaymentCondition storage pc = paymentConditions[batchId];
        if (!pc.totalAmount.isInitialized()) revert NotInitialized(); // Check if condition was submitted

        bytes32[] memory cts = new bytes32[](4);
        cts[0] = pc.amountA.toBytes32();
        cts[1] = pc.amountB.toBytes32();
        cts[2] = pc.totalAmount.toBytes32();
        cts[3] = pc.conditionMet.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures this callback is processed only once.

        PaymentCondition storage pc = paymentConditions[decryptionContexts[requestId].batchId];
        bytes32[] memory currentCts = new bytes32[](4);
        currentCts[0] = pc.amountA.toBytes32();
        currentCts[1] = pc.amountB.toBytes32();
        currentCts[2] = pc.totalAmount.toBytes32();
        currentCts[3] = pc.conditionMet.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures that the ciphertexts in storage
        // have not changed since the decryption was requested.
        if (currentStateHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 amountA = abi.decode(cleartexts[0:32], (uint32));
        uint256 amountB = abi.decode(cleartexts[32:64], (uint32));
        uint256 totalAmount = abi.decode(cleartexts[64:96], (uint32));
        bool conditionMet = abi.decode(cleartexts[96:128], (bool));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalAmount, conditionMet);
        // Actual payment logic based on conditionMet would go here
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal {
        if (!v.isInitialized()) v = FHE.asEuint32(0);
    }

    function _requireInitialized(euint32 v) internal pure {
        if (!v.isInitialized()) revert NotInitialized();
    }
}