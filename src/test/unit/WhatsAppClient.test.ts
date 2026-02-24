import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppClient } from '../../core/WhatsAppClient.js';

describe('WhatsAppClient Content Builder', () => {
    let client: any;

    beforeEach(() => {
        // We don't need a real session, just enough to satisfy the constructor
        client = new WhatsAppClient('test-session');
    });

    it('should build a text message', async () => {
        const outbound: any = { type: 'text', text: 'hello world' };
        const content = await client.buildMessageContent(outbound);
        expect(content).toEqual({ text: 'hello world' });
    });

    it('should build a voice message (ptt)', async () => {
        const outbound: any = {
            type: 'voice',
            mediaUrl: 'https://example.com/audio.ogg'
        };
        const content = await client.buildMessageContent(outbound);
        expect(content.audio).toBeDefined();
        expect(content.ptt).toBe(true);
        expect(content.mimetype).toBe('audio/ogg; codecs=opus');
    });

    it('should build an interactive button message', async () => {
        const outbound: any = {
            type: 'button',
            text: 'Choose one',
            footer: 'Selection required',
            buttons: [
                { id: '1', text: 'Option A' },
                { id: '2', text: 'Option B' }
            ]
        };
        const content = await client.buildMessageContent(outbound);
        const interactive = (content as any).viewOnceMessage.message.interactiveMessage;

        expect(interactive.body.text).toBe('Choose one');
        expect(interactive.footer.text).toBe('Selection required');
        expect(interactive.nativeFlowMessage.buttons).toHaveLength(2);
        expect(JSON.parse(interactive.nativeFlowMessage.buttons[0].buttonParamsJson)).toEqual({
            display_text: 'Option A',
            id: '1'
        });
    });

    it('should build a link preview message', async () => {
        const outbound: any = {
            type: 'link_preview',
            text: 'Check this out: https://google.com',
            previewUrl: 'https://google.com',
            previewTitle: 'Google'
        };
        const content = await client.buildMessageContent(outbound);
        expect(content.text).toBe('Check this out: https://google.com');
        expect(content.linkPreview).toBeDefined();
        expect(content.linkPreview['canonical-url']).toBe('https://google.com');
        expect(content.linkPreview.title).toBe('Google');
    });

    it('should build a live location message', async () => {
        const outbound: any = {
            type: 'live_location',
            latitude: 40.7128,
            longitude: -74.0060,
            locationName: 'NYC',
            caption: 'See where I am'
        };
        const content = await client.buildMessageContent(outbound);
        expect(content.location).toBeDefined();
        expect(content.location.isLive).toBe(true);
        expect(content.location.degreesLatitude).toBe(40.7128);
        expect(content.location.name).toBe('NYC');
    });
});
