import { sleep } from '@temporalio/workflow';
import { msToNumber } from '@temporalio/common';
import {
    createMachine,
    assign,
    EventObject,
    interpret,
    StateFrom,
    Sender,
} from 'xstate';
import {
    ElectronicSignature,
    ElectronicSignatureProcedureStatus,
} from '../interfaces';
// Only import the activity types
// import type * as activities from '../activities';

// const { greet } = createActivityHandle<typeof activities>({
//     startToCloseTimeout: '1 minute',
// });

interface ElectronicSignatureMachineContext {
    procedureTimeout: number;
    email: string | undefined;
    sendingConfirmationCodeTries: number;
    confirmationCode: string | undefined;
}

type ElectronicSignatureMachineEvents =
    | {
          type: 'PROCEDURE_TIMEOUT';
      }
    | {
          type: 'ACCEPT_DOCUMENT';
      }
    | {
          type: 'SET_EMAIL';
          email: string;
      }
    | {
          type: 'SENT_CONFIRMATION_CODE';
          confirmationCode: string;
      }
    | {
          type: 'VALIDATE_CONFIRMATION_CODE';
          confirmationCode: string;
      }
    | {
          type: 'RESEND_CONFIRMATION_CODE';
      }
    | {
          type: 'CANCEL_PROCEDURE';
      };

const electronicSignatureMachine = createMachine<
    ElectronicSignatureMachineContext,
    ElectronicSignatureMachineEvents
>(
    {
        id: 'electronicSignatureMachine',

        initial: 'pendingSignature',

        context: {
            sendingConfirmationCodeTries: 0,
            procedureTimeout: msToNumber('1 minute'),
            email: undefined,
            confirmationCode: undefined,
        },

        states: {
            pendingSignature: {
                after: {
                    PROCEDURE_TIMEOUT: {
                        target: 'procedureExpired',
                    },
                },

                initial: 'waitingAgreement',

                states: {
                    waitingAgreement: {
                        on: {
                            ACCEPT_DOCUMENT: {
                                target: 'waitingEmail',
                            },
                        },
                    },

                    waitingEmail: {
                        on: {
                            SET_EMAIL: {
                                target: 'sendingConfirmationCode',

                                actions: [
                                    'assignEmail',
                                    (_, event) => {
                                        console.log('waiting email', event);
                                    },
                                ],
                            },
                        },
                    },

                    sendingConfirmationCode: {
                        invoke: {
                            src: 'sendConfirmationCode',
                        },

                        on: {
                            SENT_CONFIRMATION_CODE: {
                                target: 'waitingConfirmationCode',

                                actions: 'assignConfirmationCode',
                            },
                        },
                    },

                    waitingConfirmationCode: {
                        on: {
                            VALIDATE_CONFIRMATION_CODE: {
                                cond: 'isConfirmationCodeCorrect',

                                target: 'procedureValidated',
                            },

                            RESEND_CONFIRMATION_CODE: {
                                cond: 'hasNotReachedConfirmationCodeSendingLimit',

                                target: 'sendingConfirmationCode',

                                actions: [
                                    'incrementSendingConfirmationCodeTries',
                                    'resetConfirmationCode',
                                ],
                            },
                        },
                    },

                    procedureValidated: {
                        type: 'final',
                    },
                },

                on: {
                    CANCEL_PROCEDURE: {
                        target: 'procedureCancelled',
                    },
                },

                onDone: {
                    target: 'procedureValidated',
                },
            },

            procedureExpired: {
                type: 'final',
            },

            procedureValidated: {
                type: 'final',
            },

            procedureCancelled: {
                type: 'final',
            },
        },
    },

    {
        services: {
            sendConfirmationCode: () => (sendBack) => {
                setTimeout(() => {
                    const confirmationCode = '918273';

                    sendBack({
                        type: 'SENT_CONFIRMATION_CODE',
                        confirmationCode,
                    });
                }, 500);
            },
        },

        guards: {
            hasNotReachedConfirmationCodeSendingLimit: ({
                sendingConfirmationCodeTries,
            }) => sendingConfirmationCodeTries < 3,

            isConfirmationCodeCorrect: ({ confirmationCode }, event) => {
                assertEventType(event, 'VALIDATE_CONFIRMATION_CODE');

                return confirmationCode === event.confirmationCode;
            },
        },

        actions: {
            incrementSendingConfirmationCodeTries: assign({
                sendingConfirmationCodeTries: ({
                    sendingConfirmationCodeTries,
                }) => sendingConfirmationCodeTries + 1,
            }),

            assignEmail: assign({
                email: (_, event) => {
                    assertEventType(event, 'SET_EMAIL');

                    return event.email;
                },
            }),

            assignConfirmationCode: assign({
                confirmationCode: (_, event) => {
                    assertEventType(event, 'SENT_CONFIRMATION_CODE');

                    return event.confirmationCode;
                },
            }),

            resetConfirmationCode: assign({
                confirmationCode: (_context, _event) => undefined,
            }),
        },

        delays: {
            PROCEDURE_TIMEOUT: ({ procedureTimeout }) => procedureTimeout,
        },
    },
);

function assertEventType<TE extends EventObject, TType extends TE['type']>(
    event: TE,
    eventType: TType,
): asserts event is TE & { type: TType } {
    if (event.type !== eventType) {
        throw new Error(
            `Invalid event: expected "${eventType}", got "${event.type}"`,
        );
    }
}

export const electronicSignature: ElectronicSignature = () => {
    let state: StateFrom<typeof electronicSignatureMachine>;
    let send: Sender<ElectronicSignatureMachineEvents>;

    return {
        async execute(): Promise<string> {
            const service = interpret(electronicSignatureMachine, {
                clock: {
                    setTimeout(fn, timeout) {
                        sleep(timeout).then(fn);
                    },
                    clearTimeout() {
                        return undefined;
                    },
                },
            })
                .onTransition((updatedState) => {
                    console.log('transition to', updatedState.value);

                    state = updatedState;
                })
                .start();
            send = service.send.bind(service);

            console.log('waiting for final state');
            await new Promise((resolve) => {
                service.onDone(() => {
                    console.log('reached final state');

                    resolve(undefined);
                });
            });

            return 'electronic signature';
        },

        queries: {
            status(): ElectronicSignatureProcedureStatus {
                if (state.matches('pendingSignature.waitingAgreement')) {
                    return 'PENDING.WAITING_AGREEMENT';
                }
                if (state.matches('pendingSignature.waitingEmail')) {
                    return 'PENDING.WAITING_EMAIL';
                }
                if (state.matches('pendingSignature.sendingConfirmationCode')) {
                    return 'PENDING.SENDING_CONFIRMATION_CODE';
                }
                if (state.matches('pendingSignature.waitingConfirmationCode')) {
                    return 'PENDING.WAITING_CONFIRMATION_CODE';
                }
                if (state.matches('procedureExpired')) {
                    return 'EXPIRED';
                }
                if (state.matches('procedureValidated')) {
                    return 'VALIDATED';
                }
                if (state.matches('procedureCancelled')) {
                    return 'CANCELLED';
                }

                throw new Error(
                    'Reached unreachable state; a state has probably been added or renamed from the state machine',
                );
            },
        },

        signals: {
            acceptDocument() {
                send({
                    type: 'ACCEPT_DOCUMENT',
                });
            },

            setEmailForCode(email: string) {
                send({
                    type: 'SET_EMAIL',
                    email,
                });
            },

            validateConfirmationCode(confirmationCode: string) {
                send({
                    type: 'VALIDATE_CONFIRMATION_CODE',
                    confirmationCode,
                });
            },

            resendConfirmationCode() {
                send({
                    type: 'RESEND_CONFIRMATION_CODE',
                });
            },

            cancelProcedure() {
                send({
                    type: 'CANCEL_PROCEDURE',
                });
            },
        },
    };
};
