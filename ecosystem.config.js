module.exports = {
    apps: [
        {
            name: 'whatsapp-api',
            script: './dist/app.js',
            instances: 1, // Single instance for WhatsApp socket stability
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
            },
            error_file: './logs/error.log',
            out_file: './logs/out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            merge_logs: true,
        },
    ],
};
