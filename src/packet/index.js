'use strict'

const Header = require('./header')
const Transaction = require('../transaction')
const Challenge = require('./challenge')
const Message = require('./message')

const { waterfall } = require('neo-async')

const { RELAY_FEE } = require('../constants')
const { hash, bufferXOR, deepCopy, log, pubKeyToEthereumAddress, getId, bufferToNumber, pubKeyToPeerId } = require('../utils')
const { BN } = require('web3-utils')

class Packet {
    constructor(header, transaction, challenge, message) {
        this.header = header
        this.transaction = transaction
        this.challenge = challenge
        this.message = message
    }

    static get SIZE() {
        return Header.SIZE + Transaction.SIZE + Challenge.SIZE + Message.SIZE
    }

    static createPacket(node, msg, path, cb) {
        const { header, secrets, identifier } = Header.createHeader(path)

        log(node.peerInfo.id, '---------- New Packet ----------')
        path
            .slice(0, Math.max(0, path.length - 1))
            .forEach((peerId, index) => log(node.peerInfo.id, `Intermediate ${index} : \x1b[34m${peerId.toB58String()}\x1b[0m`))
        log(node.peerInfo.id, `Destination    : \x1b[34m${path[path.length - 1].toB58String()}\x1b[0m`)
        log(node.peerInfo.id, '--------------------------------')


        const fee = (new BN(secrets.length - 1, 10)).imul(new BN(RELAY_FEE, 10))

        const challenge = Challenge.createChallenge(Header.deriveTransactionKey(secrets[0]), node.peerInfo.id)
        const message = Message.createMessage(msg).onionEncrypt(secrets)

        node.paymentChannels.transfer(fee, path[0], (err, tx) => {
            if (err)
                cb(err)

            log(node.peerInfo.id, `Encrypting with ${hash(bufferXOR(Header.deriveTransactionKey(secrets[0]), Header.deriveTransactionKey(secrets[1]))).toString('base64')}.`)
            const encryptedTx = tx.encrypt(hash(bufferXOR(Header.deriveTransactionKey(secrets[0]), Header.deriveTransactionKey(secrets[1]))))


            node.pendingTransactions.addEncryptedTransaction(
                hash(Header.deriveTransactionKey(secrets[0]))
            )

            cb(null, new Packet(
                header,
                encryptedTx,
                challenge,
                message)
            )

        })
    }

    forwardTransform(node, cb) {
        this.header.deriveSecret(node.peerInfo.id.privKey.marshal())

        let sender, receivedMoney, channelId, nextPeerId

        waterfall([
            (cb) => this.hasTag(node.db, cb),
            (alreadyReceived, cb) => {
                if (alreadyReceived) {

                    cb(Error('General error.'))
                } else if (!this.header.verify()) {

                    cb(Error('General error.'))
                } else {
                    this.header.extractHeaderInformation()

                    sender = this.challenge.getCounterparty(Header.deriveTransactionKey(this.header.derivedSecret))

                    channelId = getId(
                        pubKeyToEthereumAddress(node.peerInfo.id.pubKey.marshal()),
                        pubKeyToEthereumAddress(sender)
                    )

                    pubKeyToPeerId(this.header.address, cb)
                }
            },
            (_nextPeerId, cb) => {
                nextPeerId = _nextPeerId

                node.pendingTransactions.addEncryptedTransaction(
                    // channelId
                    this.header.hashedKeyHalf,
                    Header.deriveTransactionKey(this.header.derivedSecret),
                    deepCopy(this.transaction, Transaction),
                    nextPeerId
                )

                node.paymentChannels.getChannel(channelId, cb)
            },
            (record, cb) => {
                if (typeof record === 'function') {
                    // No record => no payment channel => something went wrong
                    cb(Error('General error.'))

                } else {
                    receivedMoney = node.paymentChannels.getEmbeddedMoney(this.transaction, sender, record.currentValue)
                    log(node.peerInfo.id, `Received \x1b[35m${receivedMoney.toString()} wei\x1b[0m.`)

                    if (receivedMoney.lt(RELAY_FEE)) {

                        cb(Error('Bad transaction.'))
                    } else if (bufferToNumber(record.index) + 1 != bufferToNumber(this.transaction.index)) {

                        cb(Error('General error.'))
                    } else {

                        node.paymentChannels.setChannel({
                            currentValue: this.transaction.value,
                            index: this.transaction.index
                        }, channelId, cb)
                    }
                }
            },
            (cb) => {
                log(node.peerInfo.id, `Payment channel exists. Requested SHA256 pre-image of '${Challenge.deriveHashedKey(this.header.derivedSecret).toString('base64')}' is derivable.`)

                this.oldChallenge = deepCopy(this.challenge, Challenge)
                this.message.decrypt(this.header.derivedSecret)


                if (this.header.address.compare(node.peerInfo.id.pubKey.marshal()) === 0) {
                    cb(null, this)
                } else {
                    this.challenge.updateChallenge(this.header.hashedKeyHalf, node.peerInfo.id)
                    this.header.transformForNextNode()
                    const forwardedFee = receivedMoney.isub(new BN(RELAY_FEE, 10))

                    node.paymentChannels.transfer(forwardedFee, nextPeerId, (err, tx) => {
                        if (err)
                            cb(err)

                        this.transaction = tx.encrypt(this.header.encryptionKey)
                        log(node.peerInfo.id, `Encrypting with ${this.header.encryptionKey.toString('base64')}.`)

                        cb(null, this)
                    })
                }
            }
        ], (err) => {
            if (err)
                throw err

            cb(null, this)
        })
    }

    getTargetPeerId(cb) {
        pubKeyToPeerId(this.header.address, cb)
    }

    toBuffer() {
        return Buffer.concat([
            this.header.toBuffer(),
            this.transaction.toBuffer(),
            this.challenge.toBuffer(),
            this.message.toBuffer(),
        ], Packet.SIZE)
    }

    hasTag(db, cb) {
        const tag = Header.deriveTagParameters(this.header.derivedSecret)

        const key = Buffer.concat([Buffer.from('packet-tag-'), tag], 11 + 16)

        db.get(key, (err) => {
            if (err && !err.notFound) {
                cb(err)
            } else if (err.notFound) {
                db.put(key, '', (err) => cb(err, false))
            } else {
                cb(null, err.notFound)
            }
        })
    }

    static fromBuffer(buf) {
        return new Packet(
            Header.fromBuffer(buf.slice(0, Header.SIZE)),
            Transaction.fromBuffer(buf.slice(Header.SIZE, Header.SIZE + Transaction.SIZE), true),
            Challenge.fromBuffer(buf.slice(Header.SIZE + Transaction.SIZE, Header.SIZE + Transaction.SIZE + Challenge.SIZE)),
            Message.fromBuffer(buf.slice(Header.SIZE + Transaction.SIZE + Challenge.SIZE, Header.SIZE + Transaction.SIZE + Challenge.SIZE + Message.SIZE))
        )
    }
}

module.exports = Packet