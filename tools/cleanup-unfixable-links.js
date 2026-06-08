#!/usr/bin/env node

/**
 * 清理 LLM Wiki 项目中无法修复的断链
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
    lintFile: '/Users/berton/Documents/Invest/Invest/.llm-wiki/lint.json',
    wikiPath: '/Users/berton/Documents/Invest/Invest/wiki'
  },
  {
    name: 'English-Teaching',
    lintFile: '/Users/berton/Documents/English-Teaching/.llm-wiki/lint.json',
    wikiPath: '/Users/berton/Documents/English-Teaching/wiki'
  }
];

// 文件名匹配模式
const patterns = [
  (name) => `${name}.md`,
  (name) => `${name.toLowerCase()}.md`,
  (name) => `${name.replace(/\s+/g, '-')}.md`,
  (name) => `${name.replace(/\s+/g, '_')}.md`,
  (name) => `entities/${name}.md`,
  (name) => `concepts/${name}.md`,
  (name) => `sources/${name}.md`,
];

function findPageByTitle(wikiPath, title) {
  for (const pattern of patterns) {
    const fileName = pattern(title);
    const filePath = path.join(wikiPath, fileName);
    if (fs.existsSync(filePath)) {
      return true;
    }
  }
  return false;
}

function extractWikilink(text) {
  const match = text.match(/\[\[(.*?)\]\]/);
  return match ? match[1] : null;
}

function cleanupUnfixableLinks(project) {
  console.log(`\n处理项目: ${project.name}`);
  console.log('='.repeat(60));

  if (!fs.existsSync(project.lintFile)) {
    console.log(`  ❌ Lint 文件不存在: ${project.lintFile}`);
    return { removed: 0, kept: 0 };
  }

  const lintData = JSON.parse(fs.readFileSync(project.lintFile, 'utf8'));
  const brokenLinks = lintData.filter(item => item.type === 'broken-link');

  console.log(`  📊 断链总数: ${brokenLinks.length}`);

  const toRemove = [];
  const toKeep = [];

  for (const link of brokenLinks) {
    const target = extractWikilink(link.detail);
    if (!target) continue;

    // 检查是否可以修复
    const canFix = findPageByTitle(project.wikiPath, target);

    if (!canFix) {
      // 判断链接类型
      const isSourceFile = target.includes('.pdf') ||
                         target.includes('.docx') ||
                         target.includes('.pptx') ||
                         target.includes('.xlsx');

      const isGeneric = target === '[[目标页面]]' ||
                       target === '[[1]]' ||
                       target === '[[2]]' ||
                       target === '[[个读]]' ||
                       target.length <= 2;

      if (isSourceFile || isGeneric) {
        toRemove.push(link);
      } else {
        toKeep.push(link);
      }
    } else {
      toKeep.push(link);
    }
  }

  console.log(`  🗑️  可移除: ${toRemove.length} (源文件链接 + 无效链接)`);
  console.log(`  📋 保留: ${toKeep.length} (可能有效的概念链接)`);

  // 更新 lint.json
  const updatedLintData = lintData.filter(item => {
    if (item.type !== 'broken-link') return true;
    return !toRemove.find(r => r.id === item.id);
  });

  fs.writeFileSync(project.lintFile, JSON.stringify(updatedLintData, null, 2), 'utf8');

  // 分类统计移除的项目
  const sourceFileLinks = toRemove.filter(l =>
    extractWikilink(l.detail)?.includes('.pdf') ||
    extractWikilink(l.detail)?.includes('.docx')
  );

  const genericLinks = toRemove.filter(l => {
    const target = extractWikilink(l.detail);
    return target === '目标页面' ||
           target === '1' ||
           target === '2' ||
           target === '个读' ||
           target?.length <= 2;
  });

  console.log(`  移除分类:`);
  console.log(`    - 源文件链接: ${sourceFileLinks.length}`);
  console.log(`    - 无效链接: ${genericLinks.length}`);

  return { removed: toRemove.length, kept: toKeep.length };
}

async function main() {
  console.log('🧹 LLM Wiki 无法修复断链清理工具');
  console.log('='.repeat(60));

  let totalRemoved = 0;
  let totalKept = 0;

  for (const project of projects) {
    const result = cleanupUnfixableLinks(project);
    totalRemoved += result.removed;
    totalKept += result.kept;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('📋 总结');
  console.log('='.repeat(60));
  console.log(`  🗑️  已移除: ${totalRemoved} 个无效断链`);
  console.log(`  📋 保留: ${totalKept} 个可能有效的断链`);

  console.log('\n💡 说明:');
  console.log('- 移除的断链主要是：');
  console.log('  1. 指向不存在源文件（PDF/DOCX/PPTX）的链接');
  console.log('  2. 明显无效的链接（如"目标页面"、"个读"等）');
  console.log('- 保留的断链可能需要：');
  console.log('  1. 创建对应的概念页面');
  console.log('  2. 或在应用中手动选择 Skip 跳过');

  console.log('\n✅ 清理完成！');
  console.log('建议在应用中重新运行 Lint 检查以验证结果。');
}

main().catch(console.error);
