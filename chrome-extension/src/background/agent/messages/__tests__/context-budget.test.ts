import { describe, expect, it } from 'vitest';
import MessageManager from '../service';
import { HumanMessage } from '@langchain/core/messages';
describe('context budget',()=>{it('keeps history bounded',()=>{const manager=new MessageManager({maxInputTokens:1000});for(let i=0;i<30;i++)manager.addMessageWithTokens(new HumanMessage('长页面事实 '.repeat(100)));expect(manager.getMessages().length).toBeLessThan(30);});});
