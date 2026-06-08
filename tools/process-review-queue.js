#!/usr/bin/env node

/**
 * 处理 LLM Wiki 项目的审核队列
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目配置
const projects = [
  {
    name: 'Invest',
    reviewFile: '/Users/berton/Documents/Invest/Invest/.llm-wiki/review.json',
    wikiPath: '/Users/berton/Documents/Invest/Invest/wiki'
  },
  {
    name: 'English-Teaching',
    reviewFile: '/Users/berton/Documents/English-Teaching/.llm-wiki/review.json',
    wikiPath: '/Users/berton/Documents/English-Teaching/wiki'
  }
];

function processReviewQueue(project) {
  console.log(`\n处理项目: ${project.name}`);
  console.log('='.repeat(60));

  if (!fs.existsSync(project.reviewFile)) {
    console.log(`  ❌ 审核文件不存在: ${project.reviewFile}`);
    return { resolved: 0, kept: 0 };
  }

  const reviewData = JSON.parse(fs.readFileSync(project.reviewFile, 'utf8'));
  const unresolved = reviewData.filter(item => !item.resolved);

  console.log(`  📊 待处理审核项目: ${unresolved.length}`);

  // 按类型分组
  const byType = {};
  for (const item of unresolved) {
    if (!byType[item.type]) byType[item.type] = [];
    byType[item.type].push(item);
  }

  console.log(`  分类统计:`);
  for (const [type, items] of Object.entries(byType)) {
    console.log(`    - ${type}: ${items.length}`);
  }

  // 处理策略
  const toResolve = [];
  const toKeep = [];

  for (const item of unresolved) {
    switch (item.type) {
      case 'suggestion':
        // 建议类：标记为已解决（可选改进）
        toResolve.push({ ...item, resolved: true, resolvedAction: 'skipped' });
        break;

      case 'duplicate':
        // 重复类：标记为已解决
        toResolve.push({ ...item, resolved: true, resolvedAction: 'skipped' });
        break;

      case 'confirm':
        // 确认类：如果涉及断链，已通过修复脚本处理，标记为已解决
        if (item.description.includes('Broken link')) {
          toResolve.push({ ...item, resolved: true, resolvedAction: 'fixed' });
        } else {
          toKeep.push(item);
        }
        break;

      case 'missing-page':
      case 'contradiction':
        // 这些需要人工决策或深度研究，保留
        toKeep.push(item);
        break;

      default:
        toKeep.push(item);
    }
  }

  // 更新审核文件
  const updatedData = reviewData.map(item => {
    const resolved = toResolve.find(r => r.id === item.id);
    return resolved || item;
  });

  fs.writeFileSync(project.reviewFile, JSON.stringify(updatedData, null, 2), 'utf8');

  console.log(`  ✅ 自动解决: ${toResolve.length}`);
  console.log(`  📋 保留待处理: ${toKeep.length}`);

  if (toKeep.length > 0) {
    console.log(`  保留项目类型:`);
    const keptByType = {};
    for (const item of toKeep) {
      if (!keptByType[item.type]) keptByType[item.type] = 0;
      keptByType[item.type]++;
    }
    for (const [type, count] of Object.entries(keptByType)) {
      console.log(`    - ${type}: ${count}`);
    }

    console.log(`\n  示例项目:`);
    toKeep.slice(0, 3).forEach(item => {
      console.log(`    - [${item.type}] ${item.title}`);
    });
  }

  return { resolved: toResolve.length, kept: toKeep.length };
}

async function main() {
  console.log('🔍 LLM Wiki 审核队列处理工具');
  console.log('='.repeat(60));

  let totalResolved = 0;
  let totalKept = 0;

  for (const project of projects) {
    const result = processReviewQueue(project);
    totalResolved += result.resolved;
    totalKept += result.kept;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('📋 总结');
  console.log('='.repeat(60));
  console.log(`  ✅ 自动解决: ${totalResolved} 个`);
  console.log(`  📋 保留待处理: ${totalKept} 个`);

  console.log('\n💡 后续步骤:');
  console.log('1. 在应用中打开项目，查看审核队列');
  console.log('2. 对于 missing-page 项目，可以：');
  console.log('   - 使用 Deep Research 功能来补充内容');
  console.log('   - 或选择 Skip 跳过');
  console.log('3. 对于 contradiction 项目，建议创建研究查询来跟踪');
}

main().catch(console.error);
