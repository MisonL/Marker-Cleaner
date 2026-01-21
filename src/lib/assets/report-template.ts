export const REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Marker Cleaner 处理报告</title>
    <style>
        :root {
            --bg: #f8f9fa;
            --sidebar-bg: #ffffff;
            --card-bg: #ffffff;
            --text: #212529;
            --primary: #0d6efd;
            --success: #198754;
            --danger: #dc3545;
            --border: #dee2e6;
            --sidebar-width: 280px;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #121212;
                --sidebar-bg: #1e1e1e;
                --card-bg: #1e1e1e;
                --text: #e0e0e0;
                --border: #333;
            }
        }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; margin: 0; display: flex; height: 100vh; overflow: hidden; }
        
        /* 侧边栏样式 */
        .sidebar { width: var(--sidebar-width); background: var(--sidebar-bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
        .sidebar-header { padding: 20px; border-bottom: 1px solid var(--border); }
        .sidebar-header h2 { margin: 0; font-size: 18px; color: var(--primary); }
        .sidebar-content { flex: 1; overflow-y: auto; padding: 10px 0; }
        
        .nav-section { margin-bottom: 20px; }
        .nav-section-title { padding: 0 20px 10px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
        .nav-item { display: block; padding: 8px 20px; color: var(--text); text-decoration: none; font-size: 14px; transition: all 0.2s; border-left: 3px solid transparent; }
        .nav-item:hover { background: rgba(0,0,0,0.05); }
        .nav-item.active { background: rgba(13, 110, 253, 0.1); color: var(--primary); border-left-color: var(--primary); font-weight: bold; }
        .nav-item.sub { padding-left: 35px; font-size: 13px; color: #666; border-left: none; opacity: 0.8; }
        .nav-item.sub:hover { opacity: 1; color: var(--primary); }
        
        /* 主内容区 */
        .main-content { flex: 1; overflow-y: auto; padding: 40px; }
        .container { max-width: 1000px; margin: 0 auto; }
        
        header { margin-bottom: 30px; border-bottom: 2px solid var(--border); padding-bottom: 20px; }
        h1 { margin: 0; font-size: 24px; color: var(--primary); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
        .stat-card { background: var(--card-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--border); }
        .stat-label { font-size: 12px; color: #888; text-transform: uppercase; }
        .stat-value { font-size: 20px; font-weight: bold; margin-top: 5px; }
        
        .item-list { margin-top: 40px; }
        .item-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 25px; overflow: hidden; scroll-margin-top: 20px; }
        .item-header { padding: 10px 20px; background: rgba(0,0,0,0.05); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .item-title { font-weight: bold; font-family: monospace; }
        .item-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
        .status-success { background: var(--success); color: white; }
        .status-error { background: var(--danger); color: white; }
        
        .image-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 20px; }
        .img-container { position: relative; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; background: #eee; background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px; }
        img { width: 100%; height: auto; display: block; }
        .img-label { position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.6); color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
        
        .item-footer { padding: 10px 20px; font-size: 13px; color: #888; border-top: 1px solid var(--border); display: flex; gap: 20px; }
        .error-msg { padding: 20px; color: var(--danger); font-family: monospace; }

        /* 响应式 */
        @media (max-width: 900px) {
            body { flex-direction: column; overflow: auto; height: auto; }
            .sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
            .sidebar-content { max-height: 200px; }
            .main-content { padding: 20px; }
        }
    </style>
</head>
<body>
    <aside class="sidebar">
        <div class="sidebar-header">
            <h2>Marker Cleaner</h2>
        </div>
        <div class="sidebar-content">
            <div class="nav-section">
                <div class="nav-section-title">所有任务历史</div>
                {{TASK_NAV}}
            </div>
            
            <div class="nav-section">
                <div class="nav-section-title">当前任务图片</div>
                {{ITEM_NAV}}
            </div>
        </div>
    </aside>

    <main class="main-content">
        <div class="container">
            <header>
                <h1>清洗任务报告 (Artifact)</h1>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-label">处理结果</div>
                        <div class="stat-value">{{SUCCESS_COUNT}} / {{TOTAL_COUNT}} 成功</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">累计成本</div>
                        <div class="stat-value" style="color: #d4a373">\${{TOTAL_COST}}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">消耗 Tokens</div>
                        <div class="stat-value">{{TOTAL_TOKENS}}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">总计时长</div>
                        <div class="stat-value">{{TOTAL_DURATION}}</div>
                    </div>
                </div>
            </header>

            <div class="item-list">
                {{ITEM_LIST}}
            </div>
        </div>
    </main>
</body>
</html>`;
